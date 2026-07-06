import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface OpenApiSpec {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
}

const DEFAULT_SPEC_PATH = path.resolve(__dirname, '../../openapi/openapi.yaml');

export function loadOpenApiSpec(specPath: string = DEFAULT_SPEC_PATH): OpenApiSpec {
  const raw = fs.readFileSync(specPath, 'utf-8');
  const parsed = yaml.load(raw);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('openapi' in parsed) ||
    !('paths' in parsed)
  ) {
    throw new Error(`Invalid OpenAPI document at ${specPath}: missing 'openapi'/'paths' keys`);
  }
  return parsed as OpenApiSpec;
}

/** Converts a Fastify route path (`/features/:id`) to the OpenAPI template form (`/features/{id}`). */
export function fastifyPathToOpenApiPath(fastifyPath: string): string {
  return fastifyPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

export function isDocumentedRoute(spec: OpenApiSpec, method: string, fastifyPath: string): boolean {
  const openApiPath = fastifyPathToOpenApiPath(fastifyPath);
  const pathItem = spec.paths[openApiPath];
  if (!pathItem) return false;
  return method.toLowerCase() in pathItem;
}

export function allDocumentedOperations(spec: OpenApiSpec): Set<string> {
  const ops = new Set<string>();
  for (const [routePath, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods)) {
      ops.add(`${method.toUpperCase()} ${routePath}`);
    }
  }
  return ops;
}
