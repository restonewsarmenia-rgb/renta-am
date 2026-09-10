/**
 * Обработчик заявок renta.am. Cloudflare Pages Function.
 * Файл functions/api/form.js на корне сайта сам становится адресом /api/form.
 *
 * Заявка уходит в Телеграм (главный канал) и копией в Web3Forms на почту
 * (запасной). Успехом считается доставка хотя бы одним каналом.
 *
 * Ключей в коде нет: TG_TOKEN, TG_CHAT и W3F_KEY заданы переменными
 * окружения проекта в панели Cloudflare.
 */

const SKIP = ["access_key", "botcheck", "from_name", "pretty", "photo"];
const SAY = {
  ru: { ok: "Заявка принята. Мы свяжемся с вами.",
        no: "Не получилось отправить. Напишите на office@renta.am.",
        back: "Вернуться на сайт",
        nophoto: "Фото не приложено: файл не подошёл.",
        inTg: "в Телеграме" },
  en: { ok: "Your request has been received. We will be in touch.",
        no: "The message did not go through. Please write to office@renta.am.",
        back: "Back to the site",
        // Строка по-русски и в английской версии намеренно: Телеграм читает
        // агентство, и канал у него один, русский. Человеку она не показывается.
        nophoto: "Фото не приложено: файл не подошёл.",
        inTg: "in Telegram" },
};

// Снимок соискателя. В Телеграм уходит картинкой, в почту — никогда:
// ящик фотографиями забивать нельзя, там остаётся только строка о том, что фото есть.
const PHOTO_MAX = 6 * 1024 * 1024;
const BODY_MAX = 20000;          // заявка без файла столько не весит

export const onRequestPost = async ({ request, env }) => {
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

  const nm = String(data.name || "").trim();
  const tel = String(data.tel || "").trim();
  if (!nm || !tel) return out(isJson, false, lang, 400);

  // Файл берём только если это картинка разумного веса. Не подошёл — заявку
  // всё равно принимаем, но честно пишем в тексте, что снимка не будет.
  let note = "";
  if (photo && !okPhoto(photo)) {
    note = "\n\n" + SAY[lang].nophoto;
    photo = null;
  }

  const [tg, mail] = await Promise.allSettled([
    toTelegram(env, buildText(data) + note, photo, nm),
    toMail(env, data, lang, !!photo),
  ]);
  const okTg = tg.status === "fulfilled" && tg.value === true;
  const okMail = mail.status === "fulfilled" && mail.value === true;
  if (!okTg && !okMail) return out(isJson, false, lang, 502);
  return out(isJson, true, lang, 200);
};

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
 *  отправляется браузером напрямую, и человек должен что-то увидеть. */
function out(isJson, ok, lang, status) {
  if (isJson) {
    return new Response(JSON.stringify({ success: ok }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const t = SAY[lang] || SAY.ru;
  const msg = ok ? t.ok : t.no;
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
