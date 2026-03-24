import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { driveConnections, driveFiles } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { loadConfig } from "../config.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

function getOAuthConfig() {
  const config = loadConfig();
  if (!config.googleDriveClientId || !config.googleDriveClientSecret) {
    throw unprocessable("Google Drive client ID and secret must be configured");
  }
  return {
    clientId: config.googleDriveClientId,
    clientSecret: config.googleDriveClientSecret,
  };
}

async function driveApiFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = path.startsWith("https://") ? path : `${DRIVE_API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init?.headers,
    },
  });
  return res;
}

async function refreshAccessToken(
  db: Db,
  connectionId: string,
  refreshToken: string,
): Promise<string> {
  const { clientId, clientSecret } = getOAuthConfig();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  await db
    .update(driveConnections)
    .set({
      accessToken: data.access_token,
      tokenExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(driveConnections.id, connectionId));

  return data.access_token;
}

async function getValidAccessToken(db: Db, companyId: string): Promise<string> {
  const conn = await db
    .select()
    .from(driveConnections)
    .where(eq(driveConnections.companyId, companyId))
    .then((rows) => rows[0] ?? null);
  if (!conn) throw notFound("Google Drive not connected for this company");

  const now = new Date();
  const bufferMs = 60_000; // refresh 1 min early
  if (conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() - bufferMs > now.getTime()) {
    return conn.accessToken;
  }
  return refreshAccessToken(db, conn.id, conn.refreshToken);
}

export function driveService(db: Db) {
  return {
    getConnection: (companyId: string) =>
      db
        .select()
        .from(driveConnections)
        .where(eq(driveConnections.companyId, companyId))
        .then((rows) => rows[0] ?? null),

    getAuthUrl: (companyId: string, redirectUri: string) => {
      const { clientId } = getOAuthConfig();
      const state = JSON.stringify({ companyId });
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPES,
        access_type: "offline",
        prompt: "consent",
        state,
      });
      return `${GOOGLE_AUTH_URL}?${params.toString()}`;
    },

    handleOAuthCallback: async (
      code: string,
      redirectUri: string,
      companyId: string,
      userId?: string | null,
    ) => {
      const { clientId, clientSecret } = getOAuthConfig();

      // Exchange code for tokens
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        throw new Error(`OAuth token exchange failed: ${err}`);
      }
      const tokens = (await tokenRes.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };
      if (!tokens.refresh_token) {
        throw unprocessable("No refresh token received. Please re-authorize with consent prompt.");
      }

      // Get user email
      const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const userInfo = userInfoRes.ok
        ? ((await userInfoRes.json()) as { email?: string })
        : { email: undefined };

      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

      // Upsert connection
      const existing = await db
        .select()
        .from(driveConnections)
        .where(eq(driveConnections.companyId, companyId))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        return db
          .update(driveConnections)
          .set({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            tokenExpiresAt: expiresAt,
            userEmail: userInfo.email ?? existing.userEmail,
            connectedByUserId: userId ?? existing.connectedByUserId,
            lastSyncToken: null,
            updatedAt: new Date(),
          })
          .where(eq(driveConnections.id, existing.id))
          .returning()
          .then((rows) => rows[0]);
      }

      return db
        .insert(driveConnections)
        .values({
          companyId,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          tokenExpiresAt: expiresAt,
          userEmail: userInfo.email ?? null,
          connectedByUserId: userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    disconnect: async (companyId: string) => {
      await db.delete(driveFiles).where(eq(driveFiles.companyId, companyId));
      await db.delete(driveConnections).where(eq(driveConnections.companyId, companyId));
    },

    sync: async (companyId: string) => {
      const accessToken = await getValidAccessToken(db, companyId);
      const conn = await db
        .select()
        .from(driveConnections)
        .where(eq(driveConnections.companyId, companyId))
        .then((rows) => rows[0]!);

      if (conn.lastSyncToken) {
        // Delta sync using changes API
        return syncChanges(db, companyId, accessToken, conn);
      }

      // Full sync: list all files
      return fullSync(db, companyId, accessToken, conn);
    },

    listFiles: (companyId: string, parentDriveFileId?: string | null) =>
      db
        .select()
        .from(driveFiles)
        .where(
          parentDriveFileId
            ? and(
                eq(driveFiles.companyId, companyId),
                eq(driveFiles.parentDriveFileId, parentDriveFileId),
              )
            : and(
                eq(driveFiles.companyId, companyId),
                isNull(driveFiles.parentDriveFileId),
              ),
        ),

    getFileContent: async (companyId: string, driveFileId: string) => {
      const accessToken = await getValidAccessToken(db, companyId);

      const file = await db
        .select()
        .from(driveFiles)
        .where(
          and(
            eq(driveFiles.companyId, companyId),
            eq(driveFiles.driveFileId, driveFileId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!file) throw notFound("Drive file not found");
      if (file.isFolder) throw unprocessable("Cannot download a folder");

      // For Google Docs/Sheets/Slides, export as PDF
      const googleDocsMimeTypes = [
        "application/vnd.google-apps.document",
        "application/vnd.google-apps.spreadsheet",
        "application/vnd.google-apps.presentation",
      ];
      if (googleDocsMimeTypes.includes(file.mimeType)) {
        const res = await driveApiFetch(
          accessToken,
          `/files/${driveFileId}/export?mimeType=application/pdf`,
        );
        if (!res.ok) throw new Error(`Drive export failed: ${res.status}`);
        return {
          stream: res.body!,
          contentType: "application/pdf",
          filename: `${file.name}.pdf`,
        };
      }

      const res = await driveApiFetch(accessToken, `/files/${driveFileId}?alt=media`);
      if (!res.ok) throw new Error(`Drive download failed: ${res.status}`);
      return {
        stream: res.body!,
        contentType: file.mimeType || "application/octet-stream",
        filename: file.name,
      };
    },

    createFile: async (
      companyId: string,
      opts: {
        name: string;
        content: Buffer | string;
        mimeType: string;
        parentDriveFileId?: string;
      },
    ) => {
      const accessToken = await getValidAccessToken(db, companyId);
      const metadata: Record<string, unknown> = { name: opts.name };
      if (opts.parentDriveFileId) {
        metadata.parents = [opts.parentDriveFileId];
      }

      const boundary = "paperclip_boundary";
      const body = [
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        JSON.stringify(metadata),
        `--${boundary}`,
        `Content-Type: ${opts.mimeType}`,
        "",
        typeof opts.content === "string" ? opts.content : opts.content.toString("base64"),
        `--${boundary}--`,
      ].join("\r\n");

      const res = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,parents,webViewLink,iconLink,size,modifiedTime",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body,
        },
      );
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Drive upload failed: ${err}`);
      }
      const created = (await res.json()) as DriveApiFile;

      // Insert into local cache
      await upsertDriveFile(db, companyId, created);
      return created;
    },

    updateFile: async (
      companyId: string,
      driveFileId: string,
      opts: { content: Buffer | string; mimeType: string },
    ) => {
      const accessToken = await getValidAccessToken(db, companyId);
      const body = typeof opts.content === "string" ? opts.content : new Uint8Array(opts.content);

      const res = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media&fields=id,name,mimeType,parents,webViewLink,iconLink,size,modifiedTime`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": opts.mimeType,
          },
          body,
        },
      );
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Drive update failed: ${err}`);
      }
      const updated = (await res.json()) as DriveApiFile;
      await upsertDriveFile(db, companyId, updated);
      return updated;
    },
  };
}

// --- Internal helpers ---

interface DriveApiFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  webViewLink?: string;
  iconLink?: string;
  size?: string;
  modifiedTime?: string;
  trashed?: boolean;
}

async function upsertDriveFile(db: Db, companyId: string, file: DriveApiFile) {
  const isFolder = file.mimeType === "application/vnd.google-apps.folder";
  const values = {
    companyId,
    driveFileId: file.id,
    name: file.name,
    mimeType: file.mimeType,
    parentDriveFileId: file.parents?.[0] ?? null,
    webViewLink: file.webViewLink ?? null,
    iconLink: file.iconLink ?? null,
    size: file.size ? parseInt(file.size, 10) : null,
    isFolder,
    modifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
    updatedAt: new Date(),
  };

  const existing = await db
    .select({ id: driveFiles.id })
    .from(driveFiles)
    .where(
      and(
        eq(driveFiles.companyId, companyId),
        eq(driveFiles.driveFileId, file.id),
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (existing) {
    await db
      .update(driveFiles)
      .set(values)
      .where(eq(driveFiles.id, existing.id));
  } else {
    await db.insert(driveFiles).values(values);
  }
}

async function fullSync(
  db: Db,
  companyId: string,
  accessToken: string,
  conn: { id: string; rootFolderId: string | null },
) {
  let pageToken: string | undefined;
  let totalSynced = 0;

  // Get start page token for future delta syncs
  const startTokenRes = await driveApiFetch(accessToken, "/changes/startPageToken");
  const startTokenData = startTokenRes.ok
    ? ((await startTokenRes.json()) as { startPageToken: string })
    : null;

  do {
    const params = new URLSearchParams({
      fields: "nextPageToken,files(id,name,mimeType,parents,webViewLink,iconLink,size,modifiedTime,trashed)",
      pageSize: "1000",
      q: "trashed=false",
    });
    if (conn.rootFolderId) {
      params.set("q", `'${conn.rootFolderId}' in parents and trashed=false`);
    }
    if (pageToken) params.set("pageToken", pageToken);

    const res = await driveApiFetch(accessToken, `/files?${params.toString()}`);
    if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);

    const data = (await res.json()) as {
      files: DriveApiFile[];
      nextPageToken?: string;
    };

    for (const file of data.files) {
      if (!file.trashed) {
        await upsertDriveFile(db, companyId, file);
        totalSynced++;
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  // Save sync token
  if (startTokenData) {
    await db
      .update(driveConnections)
      .set({
        lastSyncToken: startTokenData.startPageToken,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(driveConnections.id, conn.id));
  }

  return { synced: totalSynced, type: "full" as const };
}

async function syncChanges(
  db: Db,
  companyId: string,
  accessToken: string,
  conn: { id: string; lastSyncToken: string | null; rootFolderId: string | null },
) {
  if (!conn.lastSyncToken) {
    return fullSync(db, companyId, accessToken, conn);
  }

  let pageToken: string | null = conn.lastSyncToken;
  let totalSynced = 0;
  let newStartPageToken: string | null = null;

  while (pageToken) {
    const params = new URLSearchParams({
      pageToken,
      fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,webViewLink,iconLink,size,modifiedTime,trashed))",
      pageSize: "1000",
    });

    const res = await driveApiFetch(accessToken, `/changes?${params.toString()}`);
    if (!res.ok) {
      // If token is invalid, do a full sync
      if (res.status === 403 || res.status === 404) {
        return fullSync(db, companyId, accessToken, conn);
      }
      throw new Error(`Drive changes failed: ${res.status}`);
    }

    const data = (await res.json()) as {
      changes: Array<{
        fileId: string;
        removed: boolean;
        file?: DriveApiFile;
      }>;
      nextPageToken?: string;
      newStartPageToken?: string;
    };

    for (const change of data.changes) {
      if (change.removed || change.file?.trashed) {
        // Remove from local cache
        await db
          .delete(driveFiles)
          .where(
            and(
              eq(driveFiles.companyId, companyId),
              eq(driveFiles.driveFileId, change.fileId),
            ),
          );
      } else if (change.file) {
        await upsertDriveFile(db, companyId, change.file);
      }
      totalSynced++;
    }

    pageToken = data.nextPageToken ?? null;
    if (data.newStartPageToken) {
      newStartPageToken = data.newStartPageToken;
    }
  }

  if (newStartPageToken) {
    await db
      .update(driveConnections)
      .set({
        lastSyncToken: newStartPageToken,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(driveConnections.id, conn.id));
  }

  return { synced: totalSynced, type: "delta" as const };
}
