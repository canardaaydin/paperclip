import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { driveApi, type DriveFile } from "../api/drive";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Folder,
  File,
  RefreshCw,
  ChevronRight,
  ExternalLink,
  HardDrive,
} from "lucide-react";

function formatBytes(bytes: number | null) {
  if (bytes === null || bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getMimeIcon(file: DriveFile) {
  if (file.isFolder) return <Folder className="h-4 w-4 text-blue-500" />;
  if (file.iconLink) {
    return <img src={file.iconLink} alt="" className="h-4 w-4" />;
  }
  return <File className="h-4 w-4 text-muted-foreground" />;
}

interface BreadcrumbEntry {
  id: string | null;
  name: string;
}

export function DriveFiles() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [breadcrumbPath, setBreadcrumbPath] = useState<BreadcrumbEntry[]>([
    { id: null, name: "My Drive" },
  ]);
  const currentParentId = breadcrumbPath[breadcrumbPath.length - 1].id;

  useEffect(() => {
    setBreadcrumbs([{ label: "Drive Files" }]);
  }, [setBreadcrumbs]);

  const connectionQuery = useQuery({
    queryKey: queryKeys.drive.connection(selectedCompanyId!),
    queryFn: () => driveApi.getConnection(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const filesQuery = useQuery({
    queryKey: queryKeys.drive.files(selectedCompanyId!, currentParentId),
    queryFn: () => driveApi.listFiles(selectedCompanyId!, currentParentId),
    enabled: !!selectedCompanyId && connectionQuery.data?.connected === true,
  });

  const syncMutation = useMutation({
    mutationFn: () => driveApi.sync(selectedCompanyId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["drive"] });
    },
  });

  // Sync on initial load when connected
  useEffect(() => {
    if (connectionQuery.data?.connected && selectedCompanyId) {
      syncMutation.mutate();
    }
    // Only run on initial load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionQuery.data?.connected, selectedCompanyId]);

  function openFolder(file: DriveFile) {
    setBreadcrumbPath((prev) => [...prev, { id: file.driveFileId, name: file.name }]);
  }

  function navigateToBreadcrumb(index: number) {
    setBreadcrumbPath((prev) => prev.slice(0, index + 1));
  }

  if (!selectedCompanyId) return null;

  const isConnected = connectionQuery.data?.connected;

  // Sort: folders first, then alphabetical
  const sortedFiles = [...(filesQuery.data ?? [])].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HardDrive className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Drive Files</h1>
        </div>
        {isConnected && (
          <div className="flex items-center gap-2">
            {connectionQuery.data?.lastSyncedAt && (
              <span className="text-xs text-muted-foreground">
                Last synced {formatDate(connectionQuery.data.lastSyncedAt)}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 mr-1.5 ${syncMutation.isPending ? "animate-spin" : ""}`}
              />
              {syncMutation.isPending ? "Syncing..." : "Refresh"}
            </Button>
          </div>
        )}
      </div>

      {/* Not connected */}
      {connectionQuery.isSuccess && !isConnected && (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <HardDrive className="mx-auto h-10 w-10 text-muted-foreground/50" />
          <h2 className="mt-3 text-sm font-medium">Google Drive not connected</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Connect Google Drive in{" "}
            <a href="company/settings" className="text-foreground underline underline-offset-2">
              Company Settings
            </a>{" "}
            to browse and manage files.
          </p>
        </div>
      )}

      {/* Connected — file browser */}
      {isConnected && (
        <>
          {/* Breadcrumb */}
          <nav className="flex items-center gap-1 text-sm text-muted-foreground">
            {breadcrumbPath.map((entry, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3" />}
                <button
                  className={`hover:text-foreground transition-colors ${
                    i === breadcrumbPath.length - 1
                      ? "text-foreground font-medium"
                      : ""
                  }`}
                  onClick={() => navigateToBreadcrumb(i)}
                >
                  {entry.name}
                </button>
              </span>
            ))}
          </nav>

          {/* File list */}
          {filesQuery.isLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Loading files...
            </div>
          ) : sortedFiles.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {syncMutation.isPending
                ? "Syncing files from Google Drive..."
                : "No files in this folder"}
            </div>
          ) : (
            <div className="rounded-md border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                      Name
                    </th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground w-28">
                      Size
                    </th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground w-44">
                      Modified
                    </th>
                    <th className="px-4 py-2 w-10" />
                  </tr>
                </thead>
                <tbody>
                  {sortedFiles.map((file) => (
                    <tr
                      key={file.id}
                      className="border-b border-border last:border-0 hover:bg-accent/30 transition-colors"
                    >
                      <td className="px-4 py-2">
                        <button
                          className="flex items-center gap-2 text-left hover:text-foreground"
                          onClick={() => {
                            if (file.isFolder) {
                              openFolder(file);
                            } else if (file.webViewLink) {
                              window.open(file.webViewLink, "_blank");
                            }
                          }}
                        >
                          {getMimeIcon(file)}
                          <span className="truncate max-w-md">{file.name}</span>
                        </button>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {file.isFolder ? "—" : formatBytes(file.size)}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {formatDate(file.modifiedAt)}
                      </td>
                      <td className="px-4 py-2">
                        {file.webViewLink && !file.isFolder && (
                          <a
                            href={file.webViewLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
