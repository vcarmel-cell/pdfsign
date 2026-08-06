// ─── קבועי ספריות חיצוניות (CDN, גרסאות נעולות) ──────────────────
// pdf.js 3.11.174 (שהיה מוצמד כאן קודם) התברר כבעל באג רינדור אמיתי בגופנים
// מוטבעים מסוימים (טקסט עברי יוצא מבולבל/עם מרווחים שגויים על ה-canvas, גם
// שהטקסט שנשלף/מחלץ תקין) - אומת מול רינדור עצמאי (PyMuPDF) שהקובץ המקורי
// תקין; שדרוג ל-6.2.108 פותר את זה. מגרסה 4 ואילך pdf.js מפיץ רק ES module
// (‎.mjs‎), ולכן טוענים אותו דרך import() דינמי (loadPdfJs) ולא script tag רגיל.
const PDFJS_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/legacy/build/pdf.min.mjs';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/legacy/build/pdf.worker.min.mjs';
const PDFJS_CMAP_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/cmaps/';
const PDF_LIB_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
const EMAILJS_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js';

const FIELD_TYPE_LABELS = {
  text: 'טקסט',
  number: 'מספר',
  date: 'תאריך',
  checkbox: 'תיבת סימון',
  signature: 'חתימה'
};

// pdf.js מגרסה 4 ואילך מופץ רק כ-ES module, ולכן טוענים אותו ב-import() דינמי
// (עובד גם מתוך script רגיל, לא רק type="module") במקום script tag רגיל.
async function loadPdfJs() {
  const mod = await import(PDFJS_SCRIPT_URL);
  window.pdfjsLib = mod;
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
}

// עטיפה סביב pdfjsLib.getDocument שתמיד מצרפת את ה-cMaps (ראו PDFJS_CMAP_URL).
// disableFontFace: true - מכריח את pdf.js לצייר כל אות בעצמו כצורה גרפית (path)
// במקום להמיר את הגופן המוטבע ל-@font-face ולתת למנוע הגופנים של הדפדפן/המערכת
// לצייר אותו. איטי יותר, אבל לא תלוי בהתנהגות גופנים ספציפית של מחשב מסוים.
function loadPdfDocument(bytes) {
  return pdfjsLib.getDocument({ data: bytes, cMapUrl: PDFJS_CMAP_URL, cMapPacked: true, disableFontFace: true }).promise;
}

function newId() {
  return (crypto.randomUUID) ? crypto.randomUUID() : ('id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
}

// ─── קבצי PDF נשמרים כ-Base64 בתוך מסמכי Firestore (אין Firebase Storage) ──
// מגבלת מסמך ב-Firestore היא 1MB; קידוד Base64 מוסיף כ-33% נפח, ולחתימות/טקסט
// שמוטבעים בסוף יש תוספת נוספת - לכן קובץ המקור מוגבל ל-500KB בערך.
const MAX_PDF_BYTES = 500 * 1024;
const MAX_PDF_BASE64_BYTES = Math.floor(MAX_PDF_BYTES * 4 / 3) + 100 * 1024; // מרווח ביטחון להטבעות
const EMAILJS_MAX_ATTACHMENT_BYTES = 500 * 1024; // מגבלת התוכנית החינמית של EmailJS

function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── רינדור עמוד PDF לתוך canvas ───────────────────────────────
// חשוב: מחזיר cssWidth/cssHeight (גודל התצוגה), לא canvas.width/height
// (שגדול יותר פי devicePixelRatio) - כל חישוב האחוזים חייב להתבסס על ה-CSS box.
async function renderPdfPageToCanvas(page, canvas, cssWidth) {
  const unscaledViewport = page.getViewport({ scale: 1 });
  const scale = cssWidth / unscaledViewport.width;
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: scale * dpr });
  const cssHeight = cssWidth * (unscaledViewport.height / unscaledViewport.width);

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';

  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  return { cssWidth, cssHeight, pageWidthPt: unscaledViewport.width, pageHeightPt: unscaledViewport.height };
}

// ─── מתמטיקת קואורדינטות משותפת (admin.html + fill.html) ─────────
// שדה מאוחסן כאחוזים (0..1) מתוך גודל העמוד, מעוגן בפינה השמאלית-עליונה (CSS).

function pctRectToPx(field, boxWidthPx, boxHeightPx) {
  return {
    leftPx: field.xPct * boxWidthPx,
    topPx: field.yPct * boxHeightPx,
    widthPx: field.wPct * boxWidthPx,
    heightPx: field.hPct * boxHeightPx
  };
}

function pxRectToPct(rectPx, boxWidthPx, boxHeightPx) {
  return {
    xPct: rectPx.leftPx / boxWidthPx,
    yPct: rectPx.topPx / boxHeightPx,
    wPct: rectPx.widthPx / boxWidthPx,
    hPct: rectPx.heightPx / boxHeightPx
  };
}

function applyRectPx(el, rectPx) {
  el.style.left = rectPx.leftPx + 'px';
  el.style.top = rectPx.topPx + 'px';
  el.style.width = rectPx.widthPx + 'px';
  el.style.height = rectPx.heightPx + 'px';
}

// ממיר שדה (אחוזים, מעוגן top-left) לקואורדינטות pdf-lib (נקודות, מקור bottom-left)
function pctFieldToPdfCoords(field, pageWidthPt, pageHeightPt) {
  const wPt = field.wPct * pageWidthPt;
  const hPt = field.hPct * pageHeightPt;
  const xPt = field.xPct * pageWidthPt;
  const yPt = pageHeightPt - (field.yPct * pageHeightPt) - hPt;
  return { xPt, yPt, wPt, hPt };
}

// ─── לוח חתימה (עכבר + מגע, Pointer Events מאוחדים) ──────────────
function initSignaturePad(canvas) {
  canvas.style.touchAction = 'none'; // מונע גלילה/זום בזמן חתימה בטלפון
  const ctx = canvas.getContext('2d');
  let hasDrawnFlag = false;
  let drawing = false;
  let lastX = 0, lastY = 0;

  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#111';

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    const p = pos(e);
    lastX = p.x; lastY = p.y;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastX = p.x; lastY = p.y;
    hasDrawnFlag = true;
  });
  function stopDrawing(e) {
    if (!drawing) return;
    drawing = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  canvas.addEventListener('pointerup', stopDrawing);
  canvas.addEventListener('pointercancel', stopDrawing);
  canvas.addEventListener('pointerleave', stopDrawing);

  return {
    clear() {
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      hasDrawnFlag = false;
    },
    hasDrawn() { return hasDrawnFlag; },
    getDataURL() { return canvas.toDataURL('image/png'); }
  };
}
