// Metro config for the Horizon Trade monorepo.
// Tells Metro to watch the workspace root and resolve both the app's and the
// hoisted root node_modules, so `@horizon/shared` (workspace package) and all
// hoisted dependencies resolve correctly during `expo start` / `eas build`.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
