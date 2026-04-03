export type RouteDeps = {
  ALLOWED_UPLOAD_FOLDERS: Set<string>;
  CHAT_SYSTEM_DEFAULT: string;
  REALISM_DIRECTIVE_DEFAULT: string;
  REALISM_TAGS: string;
  analyzeImage: (imageUrl: string) => Promise<any[]>;
  clearSettingsCache: () => void;
  enhancePrompt: (scene: string, character: any, mode?: string) => Promise<string>;
  generateImage: (
    character: any,
    scene: string,
    model: string,
    engine?: string,
    loraOverride?: { url: string; trigger: string; scale: number },
  ) => Promise<{ url: string; revisedPrompt: string; engine: string }>;
  generateMagnificPrompt: (imageUrl: string) => Promise<string>;
  getAllSettings: () => Promise<any[]>;
  getCharacter: (name: string) => Promise<any>;
  getCharacters: () => Promise<any>;
  getGenerations: (limit?: number) => Promise<any>;
  getLoraByName: (name: string) => Promise<any>;
  getSetting: (key: string, fallback: string) => Promise<string>;
  saveGeneration: (gen: any) => Promise<void>;
  updateGeneration: (id: string, fields: any) => Promise<void>;
  updateSetting: (key: string, value: string) => Promise<void>;
};

export type AppRouteHandler = (req: Request, url: URL) => Promise<Response | null>;
