export type DiskUsage = {
  totalBytes: number;
  freeBytes: number;
  // Percentage of the filesystem in use, 0 to 100, the way `df` reports it.
  usedPercent: number;
};

// Disk of the Installation host: how full the data directory is and files that Agent-side
// commands leave for the Orchestrator to read.
export interface DiskPort {
  usage(path: string): Promise<DiskUsage>;
  // Resolves to undefined when the file does not exist.
  readFile(path: string): Promise<string | undefined>;
}
