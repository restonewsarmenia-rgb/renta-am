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

const SKIP = ["access_key", "botcheck", "from_name", "pretty"];
const SAY = {
  ru: { ok: "Заявка принята. Мы свяжемся с вами.",
        no: "Не получилось отправить. Напишите на office@renta.am.",
        back: "Вернуться на сайт" },
  en: { ok: "Your request has been received. We will be in touch.",
        no: "The message did not go through. Please write to office@renta.am.",
        back: "Back to the site" },
};

export const onRequestPost = async ({ request, env }) => {
  const ct = request.headers.get("content-type") || "";
  const isJson = ct.includes("application/json");

  // защита от мусора: заявка не бывает большой
  const len = Number(request.headers.get("content-length") || 0);
  if (len > 20000) return out(isJson, false, "ru", 413);

  let data;
  try {
    data = isJson ? await request.json() : fromForm(await request.formData());
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

  const [tg, mail] = await Promise.allSettled([
    toTelegram(env, buildText(data)),
    toMail(env, data),
  ]);
  const okTg = tg.status === "fulfilled" && tg.value === true;
  const okMail = mail.status === "fulfilled" && mail.value === true;
  if (!okTg && !okMail) return out(isJson, false, lang, 502);
  return out(isJson, true, lang, 200);
};

// любой другой метод — не наш
export const onRequest = async ({ request }) =>
  request.method === "POST"
    ? undefined
    : new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });

function fromForm(fd) {
  const d = {};
  for (const [k, v] of fd.entries()) {
    const s = String(v);
    d[k] = k in d ? d[k] + ", " + s : s;
  }
  return d;
}

/** Текст письма в Телеграм. Читаемые строки собирает браузер (поле pretty),
 *  здесь только запасной вариант — на случай отправки без скрипта. */
function buildText(d) {
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

async function toTelegram(env, text) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return false;
  const r = await fetch("https://api.telegram.org/bot" + env.TG_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TG_CHAT, text, disable_web_page_preview: true }),
  });
  const j = await r.json().catch(() => null);
  return !!(j && j.ok === true);
}

async function toMail(env, d) {
  if (!env.W3F_KEY) return false;
  const body = Object.assign({}, d, { access_key: env.W3F_KEY });
  delete body.botcheck;
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
