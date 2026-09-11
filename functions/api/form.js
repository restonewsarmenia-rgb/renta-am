/**
 * Обработчик заявок renta.am. Cloudflare Pages Function.
 * Файл functions/api/form.js на корне сайта сам становится адресом /api/form.
 *
 * Заявка уходит в Телеграм (главный канал) и копией в Web3Forms на почту
 * (запасной). Успехом считается доставка хотя бы одним каналом.
 *
 * Ключей в коде нет: TG_TOKEN, TG_CHAT и W3F_KEY заданы переменными
 * окружения проекта в панели Cloudflare.
 *
 * ЗАЩИТА ОТ ФЛУДА — 11 сентября 2026. Один человек мог прислать сотни заявок
 * подряд и забить Телеграм. Счётчики живут в D1 (база renta-form-limits,
 * привязка LIMITS): один и тот же телефон или почта — не больше двух
 * доставленных заявок в сутки, отдельно для заявки заказчика и анкеты
 * соискателя; один IP — не больше шести в час и двадцати в сутки на все формы
 * сразу (в Армении много людей сидит за одним мобильным адресом, поэтому порог
 * по IP выше, чем по контакту). Совпадение телефона и текста заявки в течение
 * десяти минут — повторный клик или переотправка — принимается молча, без
 * повторной доставки и без счёта. Сверх предела заявка не уходит никуда, а
 * посетитель видит обычный экран «принято» с других слов: «уже у нас» вместо
 * «принята». Шеф получает одно предупреждение в Телеграм на нарушителя в сутки,
 * а не по сообщению на попытку.
 *
 * Хранится только HMAC-SHA256 от телефона, почты и IP — не сами значения.
 * Ключ подписи — LIMIT_SALT, а если его нет, берётся из TG_TOKEN и W3F_KEY:
 * подглядеть исходный номер по хешу нельзя, даже зная соль. Строки старше
 * 48 часов чистятся сами, без отдельного крон-задания.
 *
 * Отказоустойчиво: нет привязки LIMITS или D1 ответил ошибкой — заявка всё
 * равно уходит, как без счётчиков. Настоящую заявку терять нельзя никогда.
 */

const SKIP = ["access_key", "botcheck", "from_name", "pretty", "photo", "ft"];
const SAY = {
  ru: { ok: "Заявка принята. Мы свяжемся с вами.",
        no: "Не получилось отправить. Напишите на office@renta.am.",
        back: "Вернуться на сайт",
        nophoto: "Фото не приложено: файл не подошёл.",
        inTg: "в Телеграме",
        limited_client: "Ваши заявки уже у нас. Мы свяжемся с вами в рабочее время.",
        limited_cand: "Ваша анкета уже у нас. Мы прочитаем её и ответим в рабочее время." },
  en: { ok: "Your request has been received. We will be in touch.",
        no: "The message did not go through. Please write to office@renta.am.",
        back: "Back to the site",
        // Строка по-русски и в английской версии намеренно: Телеграм читает
        // агентство, и канал у него один, русский. Человеку она не показывается.
        nophoto: "Фото не приложено: файл не подошёл.",
        inTg: "in Telegram",
        limited_client: "We already have your enquiries. We will be in touch during office hours.",
        limited_cand: "We already have your application. We will read it and reply during office hours." },
};

// Снимок соискателя. В Телеграм уходит картинкой, в почту — никогда:
// ящик фотографиями забивать нельзя, там остаётся только строка о том, что фото есть.
const PHOTO_MAX = 6 * 1024 * 1024;
const BODY_MAX = 20000;          // заявка без файла столько не весит

// ---- защита от флуда: пороги ----
const CONTACT_LIMIT = { max: 2, win: 24 * 3600 };   // телефон или почта, на форму
const IP_HOUR_LIMIT = { max: 6, win: 3600 };
const IP_DAY_LIMIT = { max: 20, win: 24 * 3600 };
const DUP_WINDOW_SEC = 10 * 60;      // тот же телефон и текст — повтор, не новая заявка
const WARN_COOLDOWN_SEC = 24 * 3600; // не чаще одного предупреждения Шефу в сутки
const RETENTION_SEC = 48 * 3600;     // старше — можно стереть
const BOT_MS = 3000;                 // форма заполнена быстрее — похоже на робота

export const onRequestPost = async ({ request, env, waitUntil }) => {
  const ct = request.headers.get("content-type") || "";
  // Составное тело браузер выбирает сам, когда в форме есть поле с файлом, —
  // это анкета соискателя. Остальные формы без скрипта уходят обычной
  // кодировкой, и разбирать их надо тем же formData, иначе заявка теряется.
  const multipart = ct.includes("multipart/form-data");
  const isForm = multipart || ct.includes("application/x-www-form-urlencoded");
  // Формат ответа выбираем по Accept, а не по телу запроса: со скриптом мы
  // всегда просим JSON — и при JSON-теле, и при составном с фотографией, —
  // а браузер без скрипта просит HTML. Так один обработчик обслуживает оба
  // входа при любом теле.
  const isJson = (request.headers.get("accept") || "").includes("application/json");

  // защита от мусора: без файла заявка не бывает большой, с файлом — предел 6 МБ
  const len = Number(request.headers.get("content-length") || 0);
  if (len > (multipart ? PHOTO_MAX : BODY_MAX)) return out(isJson, false, "ru", 413);

  let data;
  let photo = null;
  try {
    if (isForm) {
      const parsed = fromForm(await request.formData());
      data = parsed.data;
      photo = parsed.photo;
    } else {
      data = await request.json();
    }
  } catch (_) {
    return out(isJson, false, "ru", 400);
  }
  if (!data || typeof data !== "object") return out(isJson, false, "ru", 400);

  const lang = String(data.page || "").includes("/en/") ? "en" : "ru";

  // ловушка для роботов: поле спрятано от человека, робот его заполняет.
  // Отвечаем как при успехе, чтобы робот не подбирал обход.
  if (String(data.botcheck || "").trim()) return out(isJson, true, lang, 200);

  // робот, заполнивший форму быстрее, чем человек успел бы её прочитать: тоже
  // ответ как при успехе, ничего никуда не уходит. Значения нет (посетитель
  // без скрипта или запрос напрямую, минуя страницу) — это не повод отбросить
  // вероятно живого человека, проверка идёт по общим лимитам ниже.
  const ft = Number(data.ft);
  if (Number.isFinite(ft) && ft >= 0 && ft < BOT_MS) return out(isJson, true, lang, 200);

  const nm = String(data.name || "").trim();
  const tel = String(data.tel || "").trim();
  if (!nm || !tel) return out(isJson, false, lang, 400);

  const kind = isJobForm(data) ? "cand" : "client";

  // ---- лимиты: телефон/почта на форму, IP на все формы разом ----
  let limited = false;
  if (env.LIMITS) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const telN = normPhone(tel);
      const emailN = normEmail(data.email);
      const ip = request.headers.get("CF-Connecting-IP") || "";

      // тот же телефон и тот же текст заявки в последние десять минут —
      // человек нажал ещё раз или страница отправила заявку повторно.
      // Молча принимаем: не доставляем второй раз и не считаем как попытку.
      const dupHash = await hashHex(env, "dup:" + telN + "|" + (String(data.pretty || "").trim() || plain(data)));
      if (await checkAndTouchDup(env, dupHash, now)) {
        return out(isJson, true, lang, 200);
      }

      const checks = [];
      if (telN) checks.push({ scope: "phone:" + kind, key: await hashHex(env, "phone:" + telN), cfg: CONTACT_LIMIT, label: "телефон", tail: telN });
      if (emailN) checks.push({ scope: "email:" + kind, key: await hashHex(env, "email:" + emailN), cfg: CONTACT_LIMIT, label: "email", tail: emailN });
      if (ip) {
        const ipKey = await hashHex(env, "ip:" + ip);
        checks.push({ scope: "ip:h", key: ipKey, cfg: IP_HOUR_LIMIT, label: "IP", tail: ip });
        checks.push({ scope: "ip:d", key: ipKey, cfg: IP_DAY_LIMIT, label: "IP", tail: ip });
      }

      let over = null;
      for (const c of checks) {
        const n = await countHits(env, c.scope, c.key, now - c.cfg.win, 1);
        if (n >= c.cfg.max) { over = c; break; }
      }

      if (over) {
        limited = true;
        await recordHit(env, over.scope, over.key, 0, now);
        await maybeWarn(env, over, data, now);
      } else {
        for (const c of checks) await recordHit(env, c.scope, c.key, 1, now);
      }

      // Изредка подчищаем то, что старше 48 часов — без отдельного крон-задания.
      if (Math.random() < 0.05) {
        const cleanup = cleanupOld(env, now).catch(() => {});
        if (typeof waitUntil === "function") waitUntil(cleanup);
      }
    } catch (e) {
      // отказоустойчиво: сбой счётчика не должен стоить настоящей заявки
      limited = false;
      console.error("limit check failed", e);
    }
  }
  if (limited) return out(isJson, true, lang, 200, { limited: true, kind });

  // Файл берём только если это картинка разумного веса. Не подошёл — заявку
  // всё равно принимаем, но честно пишем в тексте, что снимка не будет.
  let note = "";
  if (photo && !okPhoto(photo)) {
    note = "\n\n" + SAY[lang].nophoto;
    photo = null;
  }

  // Локальный прогон (npx wrangler pages dev): env.DRY_RUN подделывает
  // доставку, чтобы проверить счётчики и лимиты без настоящих секретов и без
  // сети. Работает только на localhost — на настоящем сайте адрес запроса
  // никогда не будет localhost, значит переключатель молчит, даже если
  // DRY_RUN случайно попадёт в переменные окружения боевого проекта.
  const [tg, mail] = isDryRun(env, request)
    ? [{ status: "fulfilled", value: true }, { status: "fulfilled", value: true }]
    : await Promise.allSettled([
        toTelegram(env, buildText(data) + note, photo, nm),
        toMail(env, data, lang, !!photo),
      ]);
  const okTg = tg.status === "fulfilled" && tg.value === true;
  const okMail = mail.status === "fulfilled" && mail.value === true;
  if (!okTg && !okMail) return out(isJson, false, lang, 502);
  return out(isJson, true, lang, 200);
};

function isDryRun(env, request) {
  if (!env.DRY_RUN) return false;
  try {
    const host = new URL(request.url).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch (_) {
    return false;
  }
}

function okPhoto(f) {
  return String(f.type || "").startsWith("image/") && Number(f.size || 0) <= PHOTO_MAX;
}

// любой другой метод — не наш
export const onRequest = async ({ request }) =>
  request.method === "POST"
    ? undefined
    : new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });

/** Разбор составного тела. Файл уводим в отдельную переменную: в текстовых
 *  полях он превратился бы в «[object File]» и уехал бы в письмо строкой.
 *
 *  Экспортируется ради проверки (test_api.mjs): Cloudflare Pages берёт из файла
 *  только onRequest и onRequestPost, остальные имена ему безразличны. */
export function fromForm(fd) {
  const d = {};
  let photo = null;
  for (const [k, v] of fd.entries()) {
    if (v && typeof v === "object" && typeof v.arrayBuffer === "function") {
      if (k === "photo" && !photo && Number(v.size || 0) > 0) photo = v;
      continue;
    }
    const s = String(v);
    d[k] = k in d ? d[k] + ", " + s : s;
  }
  return { data: d, photo };
}

/** Текст письма в Телеграм. Читаемые строки собирает браузер (поле pretty),
 *  здесь только запасной вариант — на случай отправки без скрипта.
 *  Экспортируется ради проверки, см. fromForm. */
export function buildText(d) {
  const head = String(d.subject || "Renta").trim();
  const body = String(d.pretty || "").trim() || plain(d);
  const page = String(d.page || "").trim();
  const t = head + "\n\n" + body + (page ? "\n\n" + page : "");
  return t.length > 3900 ? t.slice(0, 3900) + "…" : t;
}

function plain(d) {
  return Object.keys(d)
    .filter((k) => !SKIP.includes(k) && k !== "subject" && k !== "page")
    .map((k) => k + ": " + String(d[k] ?? "").trim())
    .filter((s) => !s.endsWith(": "))
    .join("\n");
}

/** По какой форме пришла заявка. Отдельного поля для этого нет — используем
 *  тему письма (subject), она стоит скрытым полем в обеих формах (form_hidden
 *  в core.py) и не зависит от JS: одинаково видна и при отправке без скрипта.
 *  Экспортируется ради проверки. */
export function isJobForm(d) {
  const s = String(d.subject || "");
  return s.indexOf("анкета соискателя") !== -1 || s.indexOf("candidate application") !== -1;
}

function normPhone(s) {
  return String(s || "").replace(/\D+/g, "");
}
function normEmail(s) {
  return String(s || "").trim().toLowerCase();
}

/** Последние четыре знака — для предупреждения Шефу, полный контакт мы и сами
 *  не храним. Экспортируется ради проверки. */
export function maskTail(raw) {
  const s = String(raw || "");
  return s.length <= 4 ? "…" + s : "…" + s.slice(-4);
}

/** HMAC-SHA256 от строки. Ключ — LIMIT_SALT, если он задан отдельным секретом,
 *  иначе собирается из уже имеющихся TG_TOKEN и W3F_KEY: заводить Шефу ещё
 *  один секрет вручную незачем. Экспортируется ради проверки. */
export async function hashHex(env, s) {
  const salt = env.LIMIT_SALT || (String(env.TG_TOKEN || "") + "|" + String(env.W3F_KEY || ""));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(s));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Сколько раз этот ключ уже отмечен в окне [since, now] с данным флагом
 *  доставки (1 — дошло и посчиталось, 0 — было остановлено). */
async function countHits(env, scope, keyHash, sinceTs, delivered) {
  const r = await env.LIMITS
    .prepare("SELECT COUNT(*) AS n FROM hits WHERE scope=? AND key_hash=? AND delivered=? AND ts>=?")
    .bind(scope, keyHash, delivered, sinceTs)
    .first();
  return r ? Number(r.n) : 0;
}

async function recordHit(env, scope, keyHash, delivered, ts) {
  await env.LIMITS
    .prepare("INSERT INTO hits (scope, key_hash, delivered, ts) VALUES (?, ?, ?, ?)")
    .bind(scope, keyHash, delivered ? 1 : 0, ts)
    .run();
}

/** Тот же телефон и тот же текст в последние десять минут — не новая заявка.
 *  true — уже видели, ничего делать не надо; false — первый раз, метка поставлена. */
async function checkAndTouchDup(env, dupHash, now) {
  const row = await env.LIMITS.prepare("SELECT ts FROM dups WHERE dup_hash=?").bind(dupHash).first();
  const seen = !!(row && now - Number(row.ts) < DUP_WINDOW_SEC);
  await env.LIMITS
    .prepare("INSERT INTO dups (dup_hash, ts) VALUES (?, ?) ON CONFLICT(dup_hash) DO UPDATE SET ts=excluded.ts")
    .bind(dupHash, now)
    .run();
  return seen;
}

/** Одно предупреждение Шефу на нарушителя в сутки — не на каждую попытку. */
async function maybeWarn(env, over, data, now) {
  const row = await env.LIMITS
    .prepare("SELECT ts FROM warned WHERE scope=? AND key_hash=?")
    .bind(over.scope, over.key)
    .first();
  if (row && now - Number(row.ts) < WARN_COOLDOWN_SEC) return;
  await env.LIMITS
    .prepare("INSERT INTO warned (scope, key_hash, ts) VALUES (?, ?, ?) ON CONFLICT(scope, key_hash) DO UPDATE SET ts=excluded.ts")
    .bind(over.scope, over.key, now)
    .run();
  const stopped = await countHits(env, over.scope, over.key, now - WARN_COOLDOWN_SEC, 0);
  const form = String(data.subject || "Renta").trim();
  const text = "Много попыток подряд\nФорма: " + form +
    "\n" + over.label + ": " + maskTail(over.tail) +
    "\nОстановлено попыток: " + stopped;
  await toTelegram(env, text, null, "");
}

/** Строки старше 48 часов можно стереть — они больше не нужны ни одному счётчику. */
async function cleanupOld(env, now) {
  const cutoff = now - RETENTION_SEC;
  await env.LIMITS.prepare("DELETE FROM hits WHERE ts<?").bind(cutoff).run();
  await env.LIMITS.prepare("DELETE FROM dups WHERE ts<?").bind(cutoff).run();
  await env.LIMITS.prepare("DELETE FROM warned WHERE ts<?").bind(cutoff).run();
}

/** Телеграм: сначала текст, потом снимок отдельным сообщением-ответом.
 *
 *  Двумя вызовами, а не подписью к картинке: подпись у Телеграма ограничена
 *  1024 знаками, а анкета длиннее. Снимок идёт ответом на текст, поэтому в
 *  канале они стоят рядом и не разъезжаются, когда заявок много.
 *
 *  Успех заявки решает первый вызов. Фото не дошло — заявка всё равно принята,
 *  показывать человеку отказ из-за картинки нельзя.
 */
async function toTelegram(env, text, photo, who) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return false;
  const api = "https://api.telegram.org/bot" + env.TG_TOKEN + "/";
  const r = await fetch(api + "sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TG_CHAT, text, disable_web_page_preview: true }),
  });
  const j = await r.json().catch(() => null);
  const ok = !!(j && j.ok === true);
  if (!ok || !photo) return ok;

  try {
    const fd = new FormData();
    fd.append("chat_id", String(env.TG_CHAT));
    fd.append("photo", photo, "anketa.jpg");
    fd.append("caption", ("Фото: " + String(who || "")).slice(0, 900));
    fd.append("reply_to_message_id", String(j.result && j.result.message_id));
    fd.append("allow_sending_without_reply", "true");
    await fetch(api + "sendPhoto", { method: "POST", body: fd });
  } catch (_) {
    // молча: текст заявки уже в канале, и это главное
  }
  return true;
}

/** Почта. Снимок сюда не идёт никогда — вместо него строка о том, где он лежит. */
async function toMail(env, d, lang, hasPhoto) {
  if (!env.W3F_KEY) return false;
  const body = Object.assign({}, d, { access_key: env.W3F_KEY });
  delete body.botcheck;
  delete body.photo;
  if (hasPhoto) body[lang === "en" ? "Photo" : "Фото"] = SAY[lang].inTg;
  const r = await fetch("https://api.web3forms.com/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  return !!(j && j.success === true);
}

/** Со скриптом отвечаем JSON, без скрипта — обычной страницей: форма
 *  отправляется браузером напрямую, и человек должен что-то увидеть.
 *  extra.limited — заявка сверх лимита, human видит другие слова, каналы не тронуты. */
function out(isJson, ok, lang, status, extra) {
  extra = extra || {};
  if (isJson) {
    const body = { success: ok };
    if (extra.limited) body.limited = true;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const t = SAY[lang] || SAY.ru;
  const msg = extra.limited
    ? (extra.kind === "cand" ? t.limited_cand : t.limited_client)
    : (ok ? t.ok : t.no);
  const html =
    '<!doctype html><html lang="' + lang + '"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>Renta Staffing Agency</title>' +
    '<body style="font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;' +
    'margin:0;padding:48px 24px;background:#F6F1EF;color:#2A211D">' +
    '<div style="max-width:520px;margin:0 auto">' +
    '<h1 style="font-size:24px;line-height:1.3;margin:0 0 16px">' + msg + "</h1>" +
    '<p><a href="/" style="color:#B83E04">' + t.back + "</a></p></div></body></html>";
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
