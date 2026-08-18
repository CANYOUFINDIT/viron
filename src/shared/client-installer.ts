export type ClientInstallerPlatform = "windows" | "macos";
export type ClientInstallerArchitecture = "arm64" | "x64" | "x86" | "universal";

export interface ClientInstallerInformation {
  fileName: string;
  platform: ClientInstallerPlatform;
  architecture: ClientInstallerArchitecture | null;
  version: string | null;
  size: number;
  downloadUrl: string;
}

export interface ClientInstallerCatalog {
  items: ClientInstallerInformation[];
}
