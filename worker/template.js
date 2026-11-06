const page = __PAGE__;

const GEE_PROJECT_ID = 'fang-for-future';
const GEE_SCOPE = 'https://www.googleapis.com/auth/earthengine';
const DEFAULT_EXPERT_MODEL = 'gpt-4.1-mini';
const MAX_EXPERT_MESSAGES = 8;
const MAX_EXPERT_MESSAGE_LENGTH = 900;
const SUPHAN_BURI_BOUNDS = {
  minLat: 13.9,
  maxLat: 15.2,
  minLng: 99.2,
  maxLng: 101.0,
};

let accessTokenCache = null;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function base64Url(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToArrayBuffer(pem) {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function createServiceAccountAssertion(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = serviceAccount.token_uri || 'https://oauth2.googleapis.com/token';
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: GEE_SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3300,
  }));
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(serviceAccount.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput),
  );
  return { assertion: `${signingInput}.${base64Url(new Uint8Array(signature))}`, tokenUri };
}

async function getAccessToken(secret) {
  let serviceAccount;
  const serializedSecret = typeof secret === 'string'
    ? secret
    : secret && typeof secret === 'object'
      ? JSON.stringify(secret)
      : '';
  try {
    serviceAccount = JSON.parse(serializedSecret);
  } catch {
    console.error('Earth Engine credential is unavailable', JSON.stringify({ present: Boolean(secret), type: typeof secret }));
    throw new ApiError(
      503,
      'configuration_invalid',
      secret ? 'รูปแบบ secret ของ Google Earth Engine ไม่ถูกต้อง' : 'ยังไม่ได้ตั้งค่า secret ของ Google Earth Engine',
    );
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    console.error('Earth Engine credential is incomplete', JSON.stringify({ present: Boolean(secret), type: typeof secret }));
    throw new ApiError(503, 'configuration_invalid', 'ข้อมูล service account ของ Google Earth Engine ไม่ครบ');
  }
  if (accessTokenCache && accessTokenCache.email === serviceAccount.client_email && accessTokenCache.expiresAt > Date.now() + 60000) {
    return accessTokenCache.token;
  }

  const { assertion, tokenUri } = await createServiceAccountAssertion(serviceAccount);
  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new ApiError(502, 'authentication_failed', 'ยืนยันตัวตนกับ Google Earth Engine ไม่สำเร็จ');
  }
  accessTokenCache = {
    email: serviceAccount.client_email,
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000,
  };
  return accessTokenCache.token;
}

function approximateSquareMeters(points) {
  const radians = Math.PI / 180;
  const radius = 6378137;
  const meanLat = points.reduce((sum, point) => sum + point[0], 0) / points.length * radians;
  const projected = points.map(([lat, lng]) => [
    radius * lng * radians * Math.cos(meanLat),
    radius * lat * radians,
  ]);
  let twiceArea = 0;
  projected.forEach((point, index) => {
    const next = projected[(index + 1) % projected.length];
    twiceArea += point[0] * next[1] - next[0] * point[1];
  });
  return Math.abs(twiceArea) / 2;
}

function validatePoints(value) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 50) {
    throw new ApiError(400, 'invalid_boundary', 'ขอบเขตแปลงต้องมี 3 ถึง 50 จุด');
  }
  const points = value.map((point) => {
    if (!Array.isArray(point) || point.length !== 2) {
      throw new ApiError(400, 'invalid_boundary', 'รูปแบบพิกัดไม่ถูกต้อง');
    }
    const [lat, lng] = point.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new ApiError(400, 'invalid_boundary', 'รูปแบบพิกัดไม่ถูกต้อง');
    }
    if (lat < SUPHAN_BURI_BOUNDS.minLat || lat > SUPHAN_BURI_BOUNDS.maxLat || lng < SUPHAN_BURI_BOUNDS.minLng || lng > SUPHAN_BURI_BOUNDS.maxLng) {
      throw new ApiError(400, 'outside_area', 'ระบบสาธิตนี้รองรับเฉพาะพื้นที่ จ.สุพรรณบุรี');
    }
    return [lat, lng];
  });
  const area = approximateSquareMeters(points);
  if (area < 25 || area > 10000000) {
    throw new ApiError(400, 'invalid_area', 'ขนาดแปลงต้องอยู่ระหว่าง 25 ตร.ม. ถึง 10 ตร.กม.');
  }
  return points;
}

function buildNdviExpression(points) {
  const values = {};
  let nodeCount = 0;
  const add = (node) => {
    const id = `v${nodeCount++}`;
    values[id] = node;
    return id;
  };
  const constant = (value) => ({ constantValue: value });
  const ref = (id) => ({ valueReference: id });
  const call = (functionName, args = {}) => add({
    functionInvocationValue: { functionName, arguments: args },
  });
  const ring = points.map(([lat, lng]) => [lng, lat]);
  ring.push(ring[0]);
  const geometry = call('GeometryConstructors.Polygon', { coordinates: constant([ring]) });
  const feature = call('Feature', { geometry: ref(geometry) });
  const boundsFilter = call('Filter.intersects', {
    leftField: constant('.all'),
    rightValue: ref(feature),
  });
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 1);
  const dateRange = call('DateRange', {
    start: constant(start.toISOString().slice(0, 10)),
    end: constant(end.toISOString().slice(0, 10)),
  });
  const dateFilter = call('Filter.dateRangeContains', {
    leftValue: ref(dateRange),
    rightField: constant('system:time_start'),
  });
  const cloudFilter = call('Filter.lessThan', {
    leftField: constant('CLOUDY_PIXEL_PERCENTAGE'),
    rightValue: constant(35),
  });
  const collection = call('ImageCollection.load', { id: constant('COPERNICUS/S2_SR_HARMONIZED') });
  const inBounds = call('Collection.filter', { collection: ref(collection), filter: ref(boundsFilter) });
  const inDate = call('Collection.filter', { collection: ref(inBounds), filter: ref(dateFilter) });
  const lowCloud = call('Collection.filter', { collection: ref(inDate), filter: ref(cloudFilter) });
  const sorted = call('Collection.limit', {
    collection: ref(lowCloud),
    key: constant('CLOUDY_PIXEL_PERCENTAGE'),
    ascending: constant(true),
  });
  const image = call('Collection.first', { collection: ref(sorted) });
  const ndvi = call('Image.normalizedDifference', {
    input: ref(image),
    bandNames: constant(['B8', 'B4']),
  });
  const mean = call('Reducer.mean');
  const result = call('Image.reduceRegion', {
    image: ref(ndvi),
    reducer: ref(mean),
    geometry: ref(geometry),
    scale: constant(10),
    maxPixels: constant(10000000),
  });
  return { values, result };
}

function numberFromResult(result) {
  if (result && typeof result === 'object') {
    for (const key of ['nd', 'NDVI']) {
      const value = Number(result[key]);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

async function computeNdvi(points, env) {
  const token = await getAccessToken(env.GEE_SERVICE_ACCOUNT_JSON);
  const response = await fetch(
    `https://earthengine.googleapis.com/v1/projects/${GEE_PROJECT_ID}/value:compute`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expression: buildNdviExpression(points),
        workloadTag: 'fang-for-future-ndvi',
      }),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const providerCode = data?.error?.status || data?.error?.code || 'unknown';
    console.error('Earth Engine NDVI request failed', JSON.stringify({ status: response.status, providerCode }));
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(503, 'earth_engine_access_denied', 'บัญชี Google Earth Engine ของโครงการยังไม่มีสิทธิ์คำนวณ NDVI');
    }
    if (response.status === 429) {
      throw new ApiError(503, 'earth_engine_busy', 'Google Earth Engine กำลังมีคำขอจำนวนมาก ลองอัปเดตอีกครั้งในสักครู่');
    }
    throw new ApiError(502, 'earth_engine_failed', 'Google Earth Engine ยังประมวลผลแปลงนี้ไม่ได้');
  }
  const ndvi = numberFromResult(data.result);
  if (ndvi === null) {
    throw new ApiError(422, 'no_observation', 'ไม่พบค่าภาพ Sentinel-2 ที่ใช้คำนวณในแปลงนี้');
  }
  return {
    ndvi,
    source: 'Google Earth Engine · Sentinel-2 SR Harmonized',
    scaleMeters: 10,
  };
}

function validateExpertMessages(value) {
  if (!Array.isArray(value) || value.length < 1) {
    throw new ApiError(400, 'invalid_chat', 'กรุณาพิมพ์คำถามก่อนส่ง');
  }
  const messages = value.slice(-MAX_EXPERT_MESSAGES).map((item) => {
    const role = item && item.role;
    const content = typeof item?.content === 'string' ? item.content.trim() : '';
    if ((role !== 'user' && role !== 'assistant') || !content || content.length > MAX_EXPERT_MESSAGE_LENGTH) {
      throw new ApiError(400, 'invalid_chat', 'ข้อความแชตไม่ถูกต้องหรือยาวเกินไป');
    }
    return { role, content };
  });
  if (messages.at(-1).role !== 'user') {
    throw new ApiError(400, 'invalid_chat', 'กรุณาส่งคำถามจากผู้ใช้');
  }
  return messages;
}

function getResponseText(value) {
  if (typeof value?.output_text === 'string' && value.output_text.trim()) return value.output_text.trim();
  const parts = [];
  for (const item of value?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

async function answerExpert(messages, env) {
  const apiKey = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
  if (!apiKey) {
    throw new ApiError(503, 'configuration_missing', 'ยังไม่ได้ตั้งค่า OpenAI API key สำหรับผู้เชี่ยวชาญ AI');
  }
  const model = typeof env.OPENAI_MODEL === 'string' && env.OPENAI_MODEL.trim()
    ? env.OPENAI_MODEL.trim()
    : DEFAULT_EXPERT_MODEL;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 360,
      instructions: 'คุณคือ "ผู้เชี่ยวชาญฟาง" ของ Fang For Future สำหรับเกษตรกรไทย ตอบเป็นภาษาไทยที่กระชับ เป็นมิตร และทำตามได้จริง ช่วยเฉพาะเรื่องการจัดการฟางข้าว เช่น จังหวะอัดก้อน การลดความชื้น การเก็บรักษา ความปลอดภัยจากไฟ การไถกลบ การเตรียมส่งมอบ และการใช้หน้าโลจิสติกส์ของแอป เมื่อต้องอ้างถึงจุดรับฟางในแอป ให้บอกว่าโรงสีพูนสินไทยกำลังรับ โรงสีไพรัตน์รอรับ และโกดังฟางทรัพย์เสร็จสิ้นแล้ว อย่ารับรองคาร์บอนเครดิต ราคา รายได้ หรือผลลัพธ์ใด ๆ ว่าแน่นอน ข้อมูล NDVI และคาร์บอนในแอปเป็นเพียงการประเมินเบื้องต้น หากขาดข้อมูลสำคัญให้ถามต่อเพียง 1 คำถาม และแนะนำให้ปรึกษาเกษตรอำเภอหรือผู้รับซื้อในพื้นที่สำหรับการตัดสินใจหน้างาน',
      input: messages,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const providerCode = data?.error?.code || data?.error?.type || 'unknown';
    console.error('Expert chat request failed', JSON.stringify({ status: response.status, providerCode }));
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(503, 'expert_access_denied', 'ผู้เชี่ยวชาญ AI ยังเชื่อมต่อกับ OpenAI ไม่สำเร็จ');
    }
    if (response.status === 429) {
      throw new ApiError(503, 'expert_busy', 'ผู้เชี่ยวชาญ AI กำลังมีคำถามจำนวนมาก ลองส่งอีกครั้งในสักครู่');
    }
    throw new ApiError(502, 'expert_failed', 'ผู้เชี่ยวชาญ AI ยังตอบไม่ได้ในขณะนี้');
  }
  const message = getResponseText(data);
  if (!message) throw new ApiError(502, 'expert_empty_response', 'ผู้เชี่ยวชาญ AI ยังสร้างคำตอบไม่ได้ในขณะนี้');
  return { message };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ndvi') {
      if (request.method !== 'POST') return jsonResponse({ message: 'Method not allowed' }, 405);
      try {
        const body = await request.json();
        const points = validatePoints(body.points);
        return jsonResponse(await computeNdvi(points, env));
      } catch (error) {
        if (error instanceof ApiError) {
          return jsonResponse({ code: error.code, message: error.message }, error.status);
        }
        console.error('Unexpected NDVI request failure', error instanceof Error ? error.message : String(error));
        return jsonResponse({ code: 'unexpected_error', message: 'ยังไม่สามารถคำนวณ NDVI ได้ในขณะนี้' }, 500);
      }
    }
    if (url.pathname === '/api/expert-chat') {
      if (request.method !== 'POST') return jsonResponse({ message: 'Method not allowed' }, 405);
      try {
        const body = await request.json();
        const messages = validateExpertMessages(body.messages);
        return jsonResponse(await answerExpert(messages, env));
      } catch (error) {
        if (error instanceof ApiError) {
          return jsonResponse({ code: error.code, message: error.message }, error.status);
        }
        console.error('Unexpected expert chat failure', error instanceof Error ? error.message : String(error));
        return jsonResponse({ code: 'unexpected_error', message: 'ผู้เชี่ยวชาญ AI ยังตอบไม่ได้ในขณะนี้' }, 500);
      }
    }
    if (url.pathname !== '/' && url.pathname !== '/index.html') return new Response('Not found', { status: 404 });
    return new Response(page, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  },
};
