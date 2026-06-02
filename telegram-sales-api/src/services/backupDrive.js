const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const DRIVE_SCOPE = ["https://www.googleapis.com/auth/drive.file"];

function isDriveUploadEnabled() {
  return String(process.env.BACKUP_DRIVE_ENABLED || "").trim().toLowerCase() === "true";
}

function parseServiceAccountFromEnv() {
  const rawJson = String(process.env.BACKUP_DRIVE_SERVICE_ACCOUNT_JSON || "").trim();
  if (rawJson) {
    return JSON.parse(rawJson);
  }

  const rawBase64 = String(process.env.BACKUP_DRIVE_SERVICE_ACCOUNT_BASE64 || "").trim();
  if (rawBase64) {
    const decoded = Buffer.from(rawBase64, "base64").toString("utf8");
    return JSON.parse(decoded);
  }

  const filePath = String(process.env.BACKUP_DRIVE_SERVICE_ACCOUNT_FILE || "").trim();
  if (filePath) {
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
    const fileContent = fs.readFileSync(resolvedPath, "utf8");
    return JSON.parse(fileContent);
  }

  throw new Error("BACKUP_DRIVE_SERVICE_ACCOUNT_MISSING");
}

function normalizePrivateKey(value) {
  return String(value || "").replace(/\\n/g, "\n");
}

async function buildDriveClient() {
  const account = parseServiceAccountFromEnv();
  const clientEmail = String(account.client_email || "").trim();
  const privateKey = normalizePrivateKey(account.private_key);

  if (!clientEmail || !privateKey) {
    throw new Error("BACKUP_DRIVE_INVALID_SERVICE_ACCOUNT");
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: DRIVE_SCOPE,
  });
  await auth.authorize();

  return {
    drive: google.drive({ version: "v3", auth }),
    serviceAccountEmail: clientEmail,
  };
}

async function uploadBackupFileToDrive(filePath, options = {}) {
  const absoluteFilePath = path.resolve(filePath);
  const folderId = String(process.env.BACKUP_DRIVE_FOLDER_ID || "").trim();
  if (!folderId) {
    throw new Error("BACKUP_DRIVE_FOLDER_ID_MISSING");
  }

  const fileName = String(options.filename || "").trim() || path.basename(absoluteFilePath);
  const { drive } = await buildDriveClient();

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType: "application/gzip",
      body: fs.createReadStream(absoluteFilePath),
    },
    fields: "id,name,createdTime,size,webViewLink,webContentLink",
  });

  const data = response?.data || {};
  return {
    id: data.id || null,
    name: data.name || fileName,
    size: Number(data.size || 0),
    created_at: data.createdTime || null,
    web_view_link: data.webViewLink || null,
    web_content_link: data.webContentLink || null,
  };
}

module.exports = {
  isDriveUploadEnabled,
  uploadBackupFileToDrive,
};
