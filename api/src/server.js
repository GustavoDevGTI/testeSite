require("dotenv").config();

const express = require("express");
const fs = require("fs");
const multer = require("multer");
const helmet = require("helmet");

const { admin, port, uploadDir, uploadMaxBytes } = require("./config");
const {
  clearSessionCookie,
  getSessionFromRequest,
  requireAdminAuth,
  setSessionCookie,
  validateAdminCredentials
} = require("./adminAuth");
const {
  createSubmission,
  deleteAllSubmissions,
  listAdminSubmissions,
  listApprovedSubmissions,
  maybeDeleteUpload,
  updateSubmission,
  updateSubmissionStatus
} = require("./submissions");
const {
  createCard,
  deleteCard,
  listAdminCards,
  listPublicCards,
  promoteSubmissionToCard,
  setPromotedSubmissionCardActive,
  updateCard
} = require("./cards");
const { getPool } = require("./db");

fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: uploadMaxBytes,
    files: 1
  },
  fileFilter: (_req, file, callback) => {
    if (ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
      callback(null, true);
      return;
    }

    const error = new Error("Envie apenas imagens JPG, PNG, WEBP ou GIF.");
    error.statusCode = 400;
    callback(error);
  }
});

const app = express();
app.set("trust proxy", true);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false
}));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(uploadDir, {
  maxAge: "7d"
}));

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return "";
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  if (buffer.slice(0, 4).toString("ascii") === "GIF8") {
    return "image/gif";
  }

  if (
    buffer.slice(0, 4).toString("ascii") === "RIFF"
    && buffer.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  return "";
}

function fileToDataUrl(file) {
  if (!file?.buffer || !file?.mimetype) {
    return "";
  }

  const detectedMime = detectImageMime(file.buffer);
  if (!detectedMime || detectedMime !== file.mimetype) {
    const error = new Error("Arquivo de imagem invalido ou corrompido.");
    error.statusCode = 400;
    throw error;
  }

  return `data:${detectedMime};base64,${file.buffer.toString("base64")}`;
}

function createRateLimiter({ name, windowMs, max, message }) {
  const attempts = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = `${name}:${req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown"}`;
    const current = attempts.get(key);

    if (!current || current.resetAt <= now) {
      attempts.set(key, {
        count: 1,
        resetAt: now + windowMs
      });
      next();
      return;
    }

    current.count += 1;
    if (current.count > max) {
      res.status(429).json({ message });
      return;
    }

    attempts.set(key, current);
    next();
  };
}

const loginRateLimit = createRateLimiter({
  name: "admin-login",
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Muitas tentativas de login. Aguarde alguns minutos e tente novamente."
});

const publicSubmissionRateLimit = createRateLimiter({
  name: "public-submission",
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: "Muitos envios em pouco tempo. Aguarde alguns minutos e tente novamente."
});

function buildPayloadFromRequest(req) {
  const body = req.body || {};
  return {
    id: body.id,
    approvalStatus: body.approvalStatus,
    category: body.category,
    pointId: body.pointId,
    mapFocus: body.mapFocus,
    name: body.name,
    cnpj: body.cnpj,
    description: body.description,
    photoUrl: req.file ? fileToDataUrl(req.file) : body.photoUrl,
    imageAlt: body.imageAlt,
    instagram: body.instagram,
    whatsapp: body.whatsapp,
    email: body.email,
    phone: body.phone,
    addressLine: body.addressLine,
    daysLine: body.daysLine,
    hoursLine: body.hoursLine,
    scheduleLine: body.scheduleLine,
    subtitle: body.subtitle,
    statusLine: body.statusLine,
    serviceLine: body.serviceLine,
    mapQuery: body.mapQuery,
    directionsUrl: body.directionsUrl,
    popupTitleColor: body.popupTitleColor,
    latitude: body.latitude,
    longitude: body.longitude,
    displayOrder: body.displayOrder,
    hasWifi: body.hasWifi,
    isActive: body.isActive
  };
}

app.get("/api/health", async (_req, res, next) => {
  try {
    const pool = getPool();
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/public/submissions", async (req, res, next) => {
  try {
    const records = await listApprovedSubmissions({
      category: req.query.category
    });
    res.json({ records });
  } catch (error) {
    next(error);
  }
});

app.get("/api/public/cards", async (_req, res, next) => {
  try {
    const records = await listPublicCards();
    res.json({ records });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/session", (req, res) => {
  const session = getSessionFromRequest(req);

  if (!session) {
    clearSessionCookie(res);
    res.json({ authenticated: false });
    return;
  }

  res.json({
    authenticated: true,
    username: session.username
  });
});

app.post("/api/admin/login", loginRateLimit, (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!validateAdminCredentials(username, password)) {
    clearSessionCookie(res);
    res.status(401).json({
      message: "Usuario ou senha invalidos."
    });
    return;
  }

  setSessionCookie(res, admin.username);
  res.json({
    message: "Login realizado com sucesso.",
    username: admin.username
  });
});

app.post("/api/admin/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({
    message: "Sessao encerrada com sucesso."
  });
});

app.use("/api/admin", requireAdminAuth);

app.get("/api/admin/submissions", async (req, res, next) => {
  try {
    const records = await listAdminSubmissions({
      status: req.query.status,
      category: req.query.category
    });
    res.json({ records });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/cards", async (req, res, next) => {
  try {
    const records = await listAdminCards({
      category: req.query.category
    });
    res.json({ records });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/cards", upload.single("photo"), async (req, res, next) => {
  try {
    const record = await createCard(buildPayloadFromRequest(req));
    res.status(201).json({
      message: "Card criado com sucesso.",
      record
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/submissions", publicSubmissionRateLimit, upload.single("photo"), async (req, res, next) => {
  try {
    const record = await createSubmission(buildPayloadFromRequest(req));
    res.status(201).json({
      message: "Cadastro enviado com sucesso e aguardando validacao.",
      record
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/admin/submissions/:id", upload.single("photo"), async (req, res, next) => {
  try {
    const currentPhotoUrl = req.body.currentPhotoUrl || "";
    const record = await updateSubmission(req.params.id, buildPayloadFromRequest(req));
    if (req.file && currentPhotoUrl && currentPhotoUrl !== record.photoSrc) {
      await maybeDeleteUpload(currentPhotoUrl);
    }
    res.json({
      message: "Cadastro atualizado com sucesso.",
      record
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/admin/cards/:id", upload.single("photo"), async (req, res, next) => {
  try {
    const currentPhotoUrl = req.body.currentPhotoUrl || "";
    const record = await updateCard(req.params.id, buildPayloadFromRequest(req));
    if (req.file && currentPhotoUrl && currentPhotoUrl !== record.photoSrc) {
      await maybeDeleteUpload(currentPhotoUrl);
    }
    res.json({
      message: "Card atualizado com sucesso.",
      record
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/admin/cards/:id", async (req, res, next) => {
  try {
    const record = await deleteCard(req.params.id);
    const promotedSubmissionId = record.id.startsWith("card-cad-")
      ? record.id.slice("card-".length)
      : "";

    if (promotedSubmissionId) {
      await updateSubmissionStatus(promotedSubmissionId, "rejected").catch(() => null);
    }

    res.json({
      message: "Card excluido com sucesso.",
      record
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/admin/submissions/:id/status", async (req, res, next) => {
  try {
    const record = await updateSubmissionStatus(req.params.id, req.body.status);
    const card = record.approvalStatus === "approved"
      ? await promoteSubmissionToCard(record)
      : await setPromotedSubmissionCardActive(record.id, false);
    res.json({
      message: "Status atualizado com sucesso.",
      record,
      card
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/admin/submissions", async (_req, res, next) => {
  try {
    const deletedCount = await deleteAllSubmissions();
    res.json({
      message: `${deletedCount} cadastro(s) removido(s).`,
      deletedCount
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || (error instanceof multer.MulterError ? 400 : 500);
  const isUploadSizeError = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
  const message = isUploadSizeError
    ? `Imagem muito grande. Envie uma imagem de ate ${Math.round(uploadMaxBytes / 1024 / 1024)}MB.`
    : statusCode >= 500
      ? "Erro interno do servidor."
      : error.message || "Nao foi possivel processar a solicitacao.";

  if (statusCode >= 500) {
    console.error(error);
  }

  res.status(statusCode).json({
    message
  });
});

app.listen(port, () => {
  console.log(`API do Amargosa Turismo ouvindo na porta ${port}`);
});
