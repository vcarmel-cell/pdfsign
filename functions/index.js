const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

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

// ─── שליחת הזמנות בקבוצה (Excel -> Gmail) ─────────────────────────────
// כתובת בסיס לבניית קישור השיתוף - אין כאן location.href כמו בצד לקוח,
// ולכן קבוע מוצמד. חייב להתאים בדיוק לנתיב שבו האתר הסטטי מתפרסם בפועל.
const APP_BASE_URL = 'https://vcarmel-cell.github.io/pdfsign/';
const MAX_RECIPIENTS = 100;
const SEND_DELAY_MS = 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

exports.sendBulkInvites = onRequest(
  {
    region: 'us-central1',
    cors: ALLOWED_ORIGINS,
    timeoutSeconds: 300,
    memory: '256MiB'
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

    const templateId = req.body && req.body.templateId;
    const recipients = req.body && req.body.recipients;
    if (typeof templateId !== 'string' || !templateId) {
      res.status(400).json({ error: 'קלט לא תקין (templateId)' });
      return;
    }
    if (!Array.isArray(recipients) || !recipients.length) {
      res.status(400).json({ error: 'רשימת נמענים ריקה' });
      return;
    }
    if (recipients.length > MAX_RECIPIENTS) {
      res.status(400).json({ error: 'יותר מדי נמענים (מקסימום ' + MAX_RECIPIENTS + ' בבת אחת)' });
      return;
    }
    for (const r of recipients) {
      if (!r || typeof r.email !== 'string' || !EMAIL_RE.test(r.email.trim())) {
        res.status(400).json({ error: 'כתובת מייל לא תקינה: ' + (r && r.email) });
        return;
      }
    }

    let templateSnap;
    try {
      templateSnap = await admin.firestore().collection('templates').doc(templateId).get();
    } catch (err) {
      logger.error('Template lookup failed', err);
      res.status(500).json({ error: 'שגיאה בטעינת התבנית' });
      return;
    }
    if (!templateSnap.exists) { res.status(404).json({ error: 'התבנית לא נמצאה' }); return; }
    const template = templateSnap.data();
    if (decoded.email !== ADMIN_EMAIL && template.ownerId !== decoded.uid) {
      res.status(403).json({ error: 'אין הרשאה לתבנית זו' });
      return;
    }
    if ((template.mode || 'single') === 'multiSign') {
      res.status(400).json({ error: 'שליחת הזמנות בקבוצה זמינה רק לתבניות במצב חתימה יחידה' });
      return;
    }

    let senderSnap;
    try {
      senderSnap = await admin.firestore().collection('gmailSenders').doc(decoded.uid).get();
    } catch (err) {
      logger.error('Sender lookup failed', err);
      res.status(500).json({ error: 'שגיאה בטעינת הגדרות השולח' });
      return;
    }
    if (!senderSnap.exists) {
      res.status(400).json({ error: 'יש להגדיר קודם שליחה דרך Gmail (בעמוד התבניות)' });
      return;
    }
    const sender = senderSnap.data();
    if (!sender.email || !sender.appPassword) {
      res.status(400).json({ error: 'הגדרות Gmail חסרות - יש להגדיר מחדש' });
      return;
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: sender.email, pass: sender.appPassword }
    });
    try {
      await transporter.verify();
    } catch (err) {
      logger.error('SMTP verify failed', err);
      res.status(502).json({
        error: 'לא ניתן להתחבר לחשבון ה-Gmail. בדקו שהסיסמה שהוזנה היא App Password ' +
          '(16 תווים, מ-myaccount.google.com/apppasswords) ולא סיסמת Gmail הרגילה, ' +
          'ושהאימות הדו-שלבי מופעל בחשבון.'
      });
      return;
    }

    const templateName = template.name || 'טופס';
    const results = [];
    for (const r of recipients) {
      const email = r.email.trim();
      const name = (r.name || '').trim();
      // כתובת אישית לכל נמען - כוללת את המייל שלו (ואת השם, אם קיים) כפרמטרים
      // ב-URL, כדי ש-fill.html יוכל לתייג את ההגשה בלי לדרוש הקלדה נוספת.
      const shareLink = APP_BASE_URL + 'fill.html?id=' + encodeURIComponent(templateId) +
        '&e=' + encodeURIComponent(email) +
        (name ? '&n=' + encodeURIComponent(name) : '');
      try {
        await transporter.sendMail({
          from: sender.email,
          to: email,
          subject: 'הזמנה למילוי טופס: ' + templateName,
          text: (name ? 'שלום ' + name + ',\n\n' : 'שלום,\n\n') +
            'הוזמנת למלא ולחתום על הטופס "' + templateName + '".\n' +
            'לחצו על הקישור הבא כדי למלא:\n' + shareLink
        });
        results.push({ email: email, ok: true });
      } catch (err) {
        logger.error('Send failed', email, err);
        results.push({ email: email, ok: false, error: 'שגיאת שליחה' });
      }
      await new Promise(resolve => setTimeout(resolve, SEND_DELAY_MS));
    }

    const sent = results.filter(r => r.ok).length;

    try {
      await admin.firestore().collection('inviteBatches').add({
        templateId: templateId,
        templateName: templateName,
        ownerId: template.ownerId,
        sentBy: decoded.uid,
        sentByEmail: decoded.email || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        recipients: recipients.map(r => {
          const email = r.email.trim();
          const result = results.find(x => x.email === email);
          return { name: (r.name || '').trim(), email: email, sent: !!(result && result.ok) };
        })
      });
    } catch (err) {
      // לא חוסם את התגובה ללקוח - השליחה עצמה כבר הצליחה/נכשלה ותועדה ב-results.
      logger.error('inviteBatches write failed', err);
    }

    res.status(200).json({ sent: sent, failed: results.length - sent, results: results });
  }
);

// ─── התראה במייל למנהל על בקשת גישה חדשה (מהטופס הציבורי ב-index.html) ────
// טריגר Firestore, לא HTTP - לא דורש שום שינוי ב-index.html (שנשאר קליל
// ובלי Firebase Auth בכלל) ולא חושף endpoint ציבורי חדש. שולח דרך אותה
// תשתית Gmail/gmailSenders שכבר קיימת לשליחת הזמנות בקבוצה - נדרש שלמנהל
// עצמו יהיה מסמך gmailSenders מוגדר (אותה הגדרה בעמוד "תבניות" ב-admin.html).
exports.notifyOnAccessRequest = onDocumentCreated('accessRequests/{requestId}', async (event) => {
  const data = event.data && event.data.data();
  if (!data) return;

  let adminUid;
  try {
    const adminUser = await admin.auth().getUserByEmail(ADMIN_EMAIL);
    adminUid = adminUser.uid;
  } catch (err) {
    logger.error('Could not resolve admin UID', err);
    return;
  }

  let sender;
  try {
    const senderSnap = await admin.firestore().collection('gmailSenders').doc(adminUid).get();
    if (!senderSnap.exists) {
      logger.warn('No gmailSenders doc for admin - skipping access-request email notification. ' +
        'הגדירו שליחה דרך Gmail בעמוד "תבניות" כדי לקבל התראות על בקשות גישה.');
      return;
    }
    sender = senderSnap.data();
  } catch (err) {
    logger.error('Sender lookup failed', err);
    return;
  }
  if (!sender.email || !sender.appPassword) return;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: sender.email, pass: sender.appPassword }
  });

  const lines = [
    'התקבלה בקשת גישה חדשה מדף הבית של PDFSign:',
    '',
    'שם: ' + (data.name || ''),
    'אימייל: ' + (data.email || '')
  ];
  if (data.phone) lines.push('טלפון: ' + data.phone);
  if (data.business) lines.push('עסק: ' + data.business);
  if (data.message) lines.push('הודעה: ' + data.message);
  lines.push('', 'ניתן לצפות בכל הבקשות במסך "בקשות גישה" ב-admin.html.');

  try {
    await transporter.sendMail({
      from: sender.email,
      to: ADMIN_EMAIL,
      subject: 'בקשת גישה חדשה ל-PDFSign: ' + (data.name || ''),
      text: lines.join('\n')
    });
  } catch (err) {
    logger.error('Access-request notification email failed', err);
  }
});
