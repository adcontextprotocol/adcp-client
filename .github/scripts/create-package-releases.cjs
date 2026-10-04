const { existsSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

// GitHub rejects release bodies above 125,000 characters. A byte limit also
// keeps multibyte text safely below that ceiling without splitting characters.
const MAX_NOTES_BYTES = 120_000;

function releaseNotes(changelog, version, changelogUrl) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex(line => line === `## ${version}`);
  if (start === -1) throw new Error(`Missing changelog entry for ${version}`);
  const next = lines.findIndex((line, index) => index > start && /^## /.test(line));
  const content = lines
    .slice(start + 1, next === -1 ? undefined : next)
    .join('\n')
    .trim();
  if (Buffer.byteLength(content) <= MAX_NOTES_BYTES) return content;

  return `Release notes exceed GitHub's size limit. Read the [complete changelog](${changelogUrl}).`;
}

async function createReleases({ github, context, core, publishedPackages, cwd = process.cwd() }) {
  // The SDK root and packages/* are the repository's workspace layout. Read
  // their metadata directly so publishing does not rely on hoisted tooling.
  const rootPackage = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const directories = rootPackage.workspaces.flatMap(pattern => {
    if (!pattern.endsWith('/*')) return [pattern];
    const parent = pattern.slice(0, -2);
    return readdirSync(path.join(cwd, parent), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(path.join(cwd, parent, entry.name, 'package.json')))
      .map(entry => path.join(parent, entry.name));
  });
  const packagesByName = new Map(
    directories.map(directory => {
      const dir = path.resolve(cwd, directory);
      const packageJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      return [packageJson.name, { dir, packageJson }];
    })
  );

  for (const { name, version } of publishedPackages) {
    const tag = `${name}@${version}`;
    try {
      await github.rest.repos.getReleaseByTag({ ...context.repo, tag });
      core.info(`Skipping ${tag}: GitHub release already exists.`);
      continue;
    } catch (error) {
      if (error.status !== 404) throw error;
    }

    const pkg = packagesByName.get(name);
    if (!pkg || pkg.packageJson.version !== version) {
      throw new Error(`Published package does not match the checkout: ${name}@${version}`);
    }
    const changelogPath = path.join(pkg.dir, 'CHANGELOG.md');
    let changelog;
    try {
      changelog = readFileSync(changelogPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      core.info(`Skipping ${tag}: package has no changelog.`);
      continue;
    }
    const relativePath = path.relative(cwd, changelogPath).split(path.sep).map(encodeURIComponent).join('/');
    const changelogUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}/blob/${encodeURIComponent(tag)}/${relativePath}`;
    const body = releaseNotes(changelog, version, changelogUrl);

    await github.rest.repos.createRelease({
      ...context.repo,
      tag_name: tag,
      name: tag,
      body,
      prerelease: version.includes('-'),
    });
  }
}

module.exports = createReleases;
module.exports.releaseNotes = releaseNotes;
