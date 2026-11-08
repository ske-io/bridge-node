/**
 * Reads the variables the platform sets.
 *
 * The web server, a command and a scheduled run all inherit the process
 * environment, and `process.env` is that environment, so nothing is copied
 * anywhere before the application loads its configuration. Dotenv loaders
 * (`dotenv`, `node --env-file`, `@nestjs/config`) leave a variable that is
 * already set alone unless told to override it, so a `.env` file in the image
 * cannot replace what the platform set.
 */

/** One variable, or undefined when it is unset or empty. */
export function env(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Whether this process runs on the platform rather than on a developer's
 * machine. Off the platform the package changes nothing.
 */
export function onPlatform(): boolean {
  return env('SKE_PROJECT_TYPE') !== undefined || env('SKE_ENVIRONMENT') !== undefined;
}
