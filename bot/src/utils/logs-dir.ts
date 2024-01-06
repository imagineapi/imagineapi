import path from "path";

export function getLogsDir() {
  return path.join(process.cwd(), "logs");
}
