import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 40 * 1024;
const MAX_CHUNK_LINES = 30;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 12;

// Simple per-instance limiter. For multi-instance production deployments,
// replace this Map with a shared store such as Upstash Redis.
const buckets = globalThis.__thoiThamnongRateBuckets ?? new Map();
globalThis.__thoiThamnongRateBuckets = buckets;

const STYLE_GUIDES = {
  "ตรง": "แปลตรงความหมายด้วยภาษาพูดไทยแบบคนจริง ๆ อ่านแล้วเข้าใจทันที ไม่ต้องสวยหรู ไม่ตกแต่งเกินต้นฉบับ หากต้นฉบับมีคำหยาบหรืออารมณ์รุนแรง ให้ถ่ายทอดระดับภาษาให้เหมาะสม แต่ห้ามเติมคำหยาบเองเมื่อไม่มีในต้นฉบับ",
  "กวี": "ลึกซึ้ง เปรียบเปรย ใช้ภาพพจน์และคำแบบกวีไทย มีจังหวะนุ่มและสัมผัสเบา ๆ โดยไม่บิดเบือนใจความ",
  "โรแมนติก": "นุ่มนวล อ่อนหวาน เหมือนประโยคจากนวนิยายรัก แต่ไม่เติมความรักที่ต้นฉบับไม่ได้สื่อ",
  "ร้อยแก้ว": "ลื่นไหล อ่านง่าย เลือกคำประณีตแบบเรียงความวรรณกรรม",
  "เศร้าสุนทรีย์": "โหยหา ทอดอาลัย เงียบงันแต่เจ็บลึก โดยรักษาระดับอารมณ์ตามต้นฉบับ",
  "ฟีลลิ่ง": "เน้นอารมณ์และความรู้สึกที่เพลงต้องการสื่อ ใช้ภาษาไทยเป็นธรรมชาติ ไม่ยึดคำต่อคำจนเสียอารมณ์",
  "ดุดัน": "คงน้ำเสียงแข็งกร้าว ตรงไปตรงมา และคำแรงตามต้นฉบับ ห้ามเพิ่มความหยาบหรือความรุนแรงที่ไม่มีในต้นฉบับ",
  "เย้ายวน": "ใช้ถ้อยคำมีเสน่ห์ ชวนใจเต้นและเย้ายวนอย่างมีชั้นเชิง หลีกเลี่ยงการบรรยายเรื่องเพศอย่างโจ่งแจ้ง",
  "จุดประสงค์": "แปลตามเจตนา บริบท และสารที่เพลงต้องการสื่อ โดยรักษาความหมายหลักและไม่แต่งความหมายใหม่",
  "สละสลวย": "รักษาความหมายให้แม่นยำ พร้อมเลือกคำไทยที่งดงาม ประณีต และลื่นไหล"
};

function jsonError(message, code, status) {
  return NextResponse.json({ error: `${message} (${code})` }, { status });
}

function getClientIp(request) {
  // On Vercel, x-forwarded-for is set by the platform. Do not trust this
  // header if deploying behind an untrusted proxy.
  return (request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
}

function isRateLimited(ip) {
  const now = Date.now();
  const current = buckets.get(ip);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    buckets.set(ip, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > MAX_REQUESTS_PER_WINDOW;
}

function parseModelJson(raw) {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("E_JSON");
  return JSON.parse(cleaned.slice(first, last + 1));
}

export async function POST(request) {
  const ip = getClientIp(request);
  if (isRateLimited(ip)) {
    return jsonError("ใช้งานถี่เกินไป กรุณารอสักครู่แล้วลองใหม่", "E_RATE", 429);
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonError("ข้อมูลมีขนาดใหญ่เกินกำหนด", "E_SIZE", 413);
  }

  let body;
  try {
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return jsonError("ข้อมูลมีขนาดใหญ่เกินกำหนด", "E_SIZE", 413);
    }
    body = JSON.parse(rawBody);
  } catch {
    return jsonError("ข้อมูลคำขอไม่ถูกต้อง", "E_REQUEST", 400);
  }

  const { lines, style } = body || {};
  if (!Array.isArray(lines) || lines.length === 0 || lines.some((line) => typeof line !== "string")) {
    return jsonError("ไม่พบข้อความสำหรับแปล", "E_LINES", 400);
  }
  if (lines.length > MAX_CHUNK_LINES) {
    return jsonError(`ส่งได้ไม่เกิน ${MAX_CHUNK_LINES} บรรทัดต่อรอบ`, "E_CHUNK", 400);
  }
  if (typeof style !== "string" || !STYLE_GUIDES[style]) {
    return jsonError("ไม่พบสำนวนแปลที่เลือก", "E_STYLE", 400);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return jsonError("เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า API key", "E_CONFIG", 500);
  }

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const prompt = `คุณเป็นนักแปลวรรณกรรมไทยฝีมือเยี่ยม แปลเนื้อเพลงภาษาอังกฤษต่อไปนี้เป็นภาษาไทย
สำนวน: ${STYLE_GUIDES[style]}
กติกา: แปลทีละบรรทัดให้ตรงลำดับ จำนวนบรรทัดต้องเท่าต้นฉบับ รักษาอารมณ์ ภาพพจน์ และนัยของเพลง ใช้ภาษาไทยธรรมชาติ ไม่แปลทื่อ ๆ
ตอบเป็น JSON อย่างเดียว ไม่มี markdown: {"lines":["คำแปลบรรทัด 1",...],"note":"คำอธิบายสั้น ๆ 2-3 ประโยคเกี่ยวกับความหมายหรือการเลือกคำที่น่าสนใจ"}
เนื้อเพลง (${lines.length} บรรทัด) เป็น JSON array:
${JSON.stringify(lines)}`;

  try {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "ตอบเป็น JSON object ที่ถูกต้องเท่านั้น โดยมี lines เป็น array ของสตริงและ note เป็นสตริง" },
          { role: "user", content: prompt }
        ]
      }),
      signal: AbortSignal.timeout(90_000)
    });

    if (!upstream.ok) {
      const status = upstream.status;
      if (status === 429) return jsonError("บริการแปลกำลังมีผู้ใช้งานมาก กรุณารอสักครู่", "E_PROVIDER_RATE", 503);
      if (status === 401 || status === 403) return jsonError("เซิร์ฟเวอร์ยืนยัน API key ไม่สำเร็จ", "E_PROVIDER_AUTH", 502);
      return jsonError("บริการแปลขัดข้อง กรุณาลองอีกครั้ง", `E_PROVIDER_${status}`, 502);
    }

    const result = await upstream.json();
    const raw = result?.choices?.[0]?.message?.content;
    if (typeof raw !== "string") {
      return jsonError("บริการแปลไม่ส่งข้อความกลับมา", "E_EMPTY", 502);
    }

    let parsed;
    try {
      parsed = parseModelJson(raw);
    } catch {
      return jsonError("คำตอบอยู่ในรูปแบบ JSON ที่อ่านไม่ได้ กรุณากดแปลอีกครั้ง", "E_JSON", 502);
    }

    if (!Array.isArray(parsed.lines)) {
      return jsonError("คำตอบไม่มีรายการคำแปลที่ถูกต้อง กรุณากดแปลอีกครั้ง", "E_SHAPE", 502);
    }

    const translated = lines.map((_, index) =>
      typeof parsed.lines[index] === "string" ? parsed.lines[index] : ""
    );

    return NextResponse.json({
      lines: translated,
      note: typeof parsed.note === "string" ? parsed.note : ""
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      return jsonError("บริการแปลใช้เวลานานเกินไป กรุณากดแปลอีกครั้ง", "E_TIMEOUT", 504);
    }
    return jsonError("เชื่อมต่อบริการแปลไม่สำเร็จ กรุณาลองอีกครั้ง", "E_NETWORK", 502);
  }
}
