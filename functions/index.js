const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
const ADMIN_EMAIL = 'v.carmel@gmail.com';
const ALLOWED_ORIGINS = ['https://vcarmel-cell.github.io'];
// gemini-flash-latest הוא alias שגוגל שומרים מצביע על המודל ה"פלאש" הנוכחי
// שלהם - נבחר בכוונה במקום שם מודל מוצמד (למשל gemini-2.5-flash), כי שמות
// מודלים מוצמדים מתיישנים/מפסיקים להיות זמינים עם הזמן (ראינו את זה בפועל).
const GEMINI_MODEL = 'gemini-flash-latest';

const FIELD_TYPES = ['text', 'number', 'date', 'checkbox', 'signature'];

const FIELDS_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      page: { type: 'INTEGER' },
      xPct: { type: 'NUMBER' },
      yPct: { type: 'NUMBER' },
      wPct: { type: 'NUMBER' },
      hPct: { type: 'NUMBER' },
      label: { type: 'STRING' },
      type: { type: 'STRING', enum: FIELD_TYPES }
    },
    required: ['page', 'xPct', 'yPct', 'wPct', 'hPct', 'label', 'type']
  }
};

const PROMPT = `You are analyzing scanned pages of a Hebrew (RTL) PDF form.
Each image below is one page, preceded by a text marker "PAGE_INDEX N".
Find every blank fillable line/box meant to be hand-filled (underline blanks,
empty boxes, checkbox glyphs (☐/⬜/[ ])) and return a JSON array. For each one:
- page: the PAGE_INDEX number of the image it's on (integer, 0-based)
- xPct, yPct: top-left corner as a fraction (0..1) of that page image's width/height
- wPct, hPct: width/height as a fraction (0..1) of that page image's width/height
- label: short Hebrew label taken from the text immediately preceding/labeling the blank
- type: infer from that label text -
  date-like label (e.g. "תאריך") -> "date";
  signature-like label (e.g. "חתימה") -> "signature";
  a checkbox glyph -> "checkbox";
  clearly numeric fields (ת.ז./טלפון/סכום/מספר) -> "number";
  otherwise -> "text"
Only include blanks meant for the form-filler to write in - ignore printed body
text, titles, and already-filled example text. Coordinates must stay within [0,1].`;

exports.detectFields = onRequest(
  {
    region: 'us-central1',
    cors: ALLOWED_ORIGINS,
    secrets: [GEMINI_API_KEY],
    timeoutSeconds: 120,
    memory: '512MiB'
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (!m) { res.status(401).json({ error: 'חסר טוקן הזדהות' }); return; }
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(m[1]);
    } catch (err) {
      res.status(401).json({ error: 'טוקן הזדהות לא תקין' });
      return;
    }

    let authorized = decoded.email === ADMIN_EMAIL;
    if (!authorized) {
      try {
        const snap = await admin.firestore().collection('users').doc(decoded.uid).get();
        const data = snap.exists ? snap.data() : null;
        authorized = !!data && data.active === true && data.tier === 'premium';
      } catch (err) {
        logger.error('Firestore auth check failed', err);
        res.status(403).json({ error: 'אין הרשאה' });
        return;
      }
    }
    if (!authorized) { res.status(403).json({ error: 'אין הרשאה לתכונה זו' }); return; }

    const pages = req.body && req.body.pages;
    if (!Array.isArray(pages) || !pages.length || pages.length > 30) {
      res.status(400).json({ error: 'קלט לא תקין (pages)' });
      return;
    }
    for (const p of pages) {
      if (typeof p.page !== 'number' || typeof p.imageBase64 !== 'string' || !p.imageBase64) {
        res.status(400).json({ error: 'קלט לא תקין (page/imageBase64)' });
        return;
      }
    }

    const parts = [{ text: PROMPT }];
    pages.forEach(p => {
      parts.push({ text: 'PAGE_INDEX ' + p.page + ':' });
      parts.push({ inlineData: { mimeType: 'image/png', data: p.imageBase64 } });
    });

    let geminiRes;
    try {
      geminiRes = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY.value() },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: FIELDS_SCHEMA,
              temperature: 0.2,
              // מבטל "חשיבה מורחבת" - לא נחוצה למשימת חילוץ מבנית פשוטה כזו,
              // וללא זה כל קריאה צורכת מאות טוקנים מיותרים (עלות/זמן תגובה).
              thinkingConfig: { thinkingLevel: 'low' }
            }
          })
        }
      );
    } catch (err) {
      logger.error('Gemini fetch failed', err);
      res.status(502).json({ error: 'שגיאת תקשורת עם שירות ה-AI' });
      return;
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => '');
      logger.error('Gemini API error', geminiRes.status, errText);
      res.status(502).json({ error: 'שירות ה-AI החזיר שגיאה (' + geminiRes.status + ')' });
      return;
    }

    const geminiJson = await geminiRes.json().catch(() => null);
    const text = geminiJson && geminiJson.candidates && geminiJson.candidates[0]
      && geminiJson.candidates[0].content && geminiJson.candidates[0].content.parts
      && geminiJson.candidates[0].content.parts[0] && geminiJson.candidates[0].content.parts[0].text;
    if (!text) {
      logger.error('Gemini response missing text', JSON.stringify(geminiJson || {}).slice(0, 2000));
      res.status(502).json({ error: 'שירות ה-AI לא החזיר תוצאה' });
      return;
    }

    let fields;
    try {
      fields = JSON.parse(text);
    } catch (err) {
      res.status(502).json({ error: 'לא ניתן לפרש את תוצאת ה-AI' });
      return;
    }
    if (!Array.isArray(fields)) { res.status(502).json({ error: 'תוצאת AI בפורמט לא צפוי' }); return; }

    res.status(200).json({ fields });
  }
);
