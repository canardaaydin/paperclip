import { api } from "./client";

export interface DriveConnection {
  connected: boolean;
  userEmail?: string | null;
  lastSyncedAt?: string | null;
  rootFolderId?: string | null;
  createdAt?: string;
}

export interface DriveFile {
  id: string;
  companyId: string;
  driveFileId: string;
  name: string;
  mimeType: string;
  parentDriveFileId: string | null;
  webViewLink: string | null;
  iconLink: string | null;
  size: number | null;
  isFolder: boolean;
  modifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DriveSyncResult {
  synced: number;
  type: "full" | "delta";
}

export const driveApi = {
  getConnection: (companyId: string) =>
    api.get<DriveConnection>(`/companies/${companyId}/drive/connection`),

  getAuthUrl: (companyId: string, redirectUri: string) =>
    api.post<{ url: string }>(`/companies/${companyId}/drive/auth-url`, { redirectUri }),

  handleCallback: (companyId: string, code: string, redirectUri: string) =>
    api.post<DriveConnection>(`/companies/${companyId}/drive/callback`, { code, redirectUri }),

  disconnect: (companyId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/drive/connection`),

  sync: (companyId: string) =>
    api.post<DriveSyncResult>(`/companies/${companyId}/drive/sync`, {}),

  listFiles: (companyId: string, parentId?: string | null) => {
    const params = parentId ? `?parentId=${parentId}` : "";
    return api.get<DriveFile[]>(`/companies/${companyId}/drive/files${params}`);
  },
};
