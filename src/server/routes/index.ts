import { handleCharacterRoutes } from "./characters";
import { handleDeliveryRoutes } from "./delivery";
import { handleGenerationRoutes } from "./generation";
import { handleMediaRoutes } from "./media";
import { handlePublicRoutes } from "./public";
import { handleSettingsRoutes } from "./settings";
import type { AppRouteHandler, RouteDeps } from "./types";

export function createApiRouteHandlers(deps: RouteDeps): AppRouteHandler[] {
  return [
    (req, url) => handlePublicRoutes(req, url, deps),
    (req, url) => handleSettingsRoutes(req, url, deps),
    (req, url) => handleCharacterRoutes(req, url, deps),
    (req, url) => handleGenerationRoutes(req, url, deps),
    (req, url) => handleMediaRoutes(req, url, deps),
    (req, url) => handleDeliveryRoutes(req, url, deps),
  ];
}

export type { AppRouteHandler, RouteDeps } from "./types";
