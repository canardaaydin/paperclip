import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { driveService } from "../services/drive.js";
import { logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { Readable } from "node:stream";

export function driveRoutes(db: Db) {
  const router = Router();
  const svc = driveService(db);

  // Get connection status
  router.get("/companies/:companyId/drive/connection", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const conn = await svc.getConnection(companyId);
    if (!conn) {
      res.json({ connected: false });
      return;
    }
    res.json({
      connected: true,
      userEmail: conn.userEmail,
      lastSyncedAt: conn.lastSyncedAt,
      rootFolderId: conn.rootFolderId,
      createdAt: conn.createdAt,
    });
  });

  // Start OAuth flow — returns the URL to redirect to
  router.post("/companies/:companyId/drive/auth-url", async (req, res) => {
    const { companyId } = req.params;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const { redirectUri } = req.body as { redirectUri: string };
    if (!redirectUri) {
      res.status(400).json({ error: "redirectUri is required" });
      return;
    }

    const url = svc.getAuthUrl(companyId, redirectUri);
    res.json({ url });
  });

  // OAuth callback — exchanges code for tokens
  router.post("/companies/:companyId/drive/callback", async (req, res) => {
    const { companyId } = req.params;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const { code, redirectUri } = req.body as { code: string; redirectUri: string };
    if (!code || !redirectUri) {
      res.status(400).json({ error: "code and redirectUri are required" });
      return;
    }

    const actor = getActorInfo(req);
    const conn = await svc.handleOAuthCallback(code, redirectUri, companyId, actor.actorId);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "drive.connected",
      entityType: "company",
      entityId: companyId,
      details: { userEmail: conn.userEmail },
    });

    res.json({
      connected: true,
      userEmail: conn.userEmail,
      createdAt: conn.createdAt,
    });
  });

  // Disconnect Google Drive
  router.delete("/companies/:companyId/drive/connection", async (req, res) => {
    const { companyId } = req.params;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    await svc.disconnect(companyId);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "drive.disconnected",
      entityType: "company",
      entityId: companyId,
    });

    res.json({ ok: true });
  });

  // Trigger sync
  router.post("/companies/:companyId/drive/sync", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const result = await svc.sync(companyId);
    res.json(result);
  });

  // List files
  router.get("/companies/:companyId/drive/files", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const parentId = (req.query.parentId as string) || null;
    const files = await svc.listFiles(companyId, parentId);
    res.json(files);
  });

  // Get file content (proxy from Google Drive)
  router.get("/companies/:companyId/drive/files/:driveFileId/content", async (req, res, next) => {
    const { companyId, driveFileId } = req.params;
    assertCompanyAccess(req, companyId);

    try {
      const { stream, contentType, filename } = await svc.getFileContent(companyId, driveFileId);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `inline; filename="${filename.replaceAll('"', '')}"`);
      res.setHeader("Cache-Control", "private, no-cache");

      // Convert web ReadableStream to Node stream
      const nodeStream = Readable.fromWeb(stream as import("node:stream/web").ReadableStream);
      nodeStream.on("error", (err) => next(err));
      nodeStream.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  // Create file (for agents)
  router.post("/companies/:companyId/drive/files", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const { name, content, mimeType, parentDriveFileId } = req.body as {
      name: string;
      content: string;
      mimeType: string;
      parentDriveFileId?: string;
    };
    if (!name || !content || !mimeType) {
      res.status(400).json({ error: "name, content, and mimeType are required" });
      return;
    }

    const actor = getActorInfo(req);
    const file = await svc.createFile(companyId, {
      name,
      content,
      mimeType,
      parentDriveFileId,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "drive.file_created",
      entityType: "drive_file",
      entityId: file.id,
      details: { name, mimeType },
    });

    // Sync after write
    await svc.sync(companyId).catch(() => {});

    res.status(201).json(file);
  });

  // Update file content (for agents)
  router.put("/companies/:companyId/drive/files/:driveFileId", async (req, res) => {
    const { companyId, driveFileId } = req.params;
    assertCompanyAccess(req, companyId);

    const { content, mimeType } = req.body as { content: string; mimeType: string };
    if (!content || !mimeType) {
      res.status(400).json({ error: "content and mimeType are required" });
      return;
    }

    const actor = getActorInfo(req);
    const file = await svc.updateFile(companyId, driveFileId, { content, mimeType });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "drive.file_updated",
      entityType: "drive_file",
      entityId: file.id,
      details: { name: file.name, mimeType },
    });

    // Sync after write
    await svc.sync(companyId).catch(() => {});

    res.json(file);
  });

  return router;
}
