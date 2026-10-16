/**
 * In-memory fake of the official `@google-cloud/storage` surface the GCS
 * row-object provider and the live-validation script use: bucket(),
 * file(name, { generation }), save, getMetadata, createReadStream, delete, and
 * bucket.getFiles({ prefix, versions }).
 */
const { Readable } = require('node:stream');

const SECRET = 'ya29.secret-access-token';

function apiError(code) {
  // Real ApiErrors carry request details; the provider must never surface them.
  return Object.assign(new Error(`HTTP ${code} for gs://bucket/key token=${SECRET}`), { code });
}

const safeBucket = () => ({
  iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' },
  versioning: { enabled: true },
  softDeletePolicy: { retentionDurationSeconds: '604800' },
  retentionPolicy: { retentionPeriod: '86400' },
});

function createFakeStorage({ bucketMetadata = safeBucket(), buckets = ['rows-bucket'] } = {}) {
  const objects = new Map(); // `${bucket}/${name}` -> [{ generation, bytes, metadata }]
  let nextGeneration = 1_700_000_000_000_001;
  const calls = [];
  const failures = {}; // op -> error to throw once
  const fail = op => {
    const error = failures[op];
    if (error) {
      delete failures[op];
      throw error;
    }
  };
  const live = path => {
    const versions = objects.get(path) ?? [];
    return versions.find(version => version.live);
  };
  const at = (path, generation) => {
    const versions = objects.get(path) ?? [];
    if (generation === undefined) return live(path);
    return versions.find(version => String(version.generation) === String(generation));
  };
  const storage = {
    calls,
    failures,
    objects,
    bucket(bucketName) {
      return {
        name: bucketName,
        async getMetadata() {
          calls.push({ op: 'bucket.getMetadata', bucketName });
          fail('bucket.getMetadata');
          if (!buckets.includes(bucketName)) throw apiError(404);
          return [structuredClone(bucketMetadata)];
        },
        async getFiles(listOptions = {}) {
          calls.push({ op: 'bucket.getFiles', bucketName, prefix: listOptions.prefix });
          fail('bucket.getFiles');
          if (!buckets.includes(bucketName)) throw apiError(404);
          const found = [];
          for (const [path, versions] of objects) {
            if (!path.startsWith(`${bucketName}/`)) continue;
            const name = path.slice(bucketName.length + 1);
            if (!name.startsWith(listOptions.prefix ?? '')) continue;
            for (const version of versions) {
              if (!listOptions.versions && !version.live) continue;
              found.push({
                name,
                generation: String(version.generation),
                metadata: {
                  name,
                  generation: String(version.generation),
                  size: String(version.bytes.length),
                  timeCreated: version.timeCreated,
                },
              });
            }
          }
          found.sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : Number(a.generation) - Number(b.generation)
          );
          if (listOptions.maxResults === undefined) return [found];
          // Paged like the real API: the token is the offset of the next object.
          const start = listOptions.pageToken ? Number(listOptions.pageToken) : 0;
          const page = found.slice(start, start + listOptions.maxResults);
          const end = start + page.length;
          return [page, end < found.length ? { ...listOptions, pageToken: String(end) } : null];
        },
        file(name, options = {}) {
          const path = `${bucketName}/${name}`;
          const pinned = options.generation;
          const file = {
            name,
            metadata: {},
            async save(bytes, saveOptions) {
              calls.push({ op: 'save', name, options: structuredClone(saveOptions) });
              fail('save');
              if (!buckets.includes(bucketName)) throw apiError(404);
              const precondition = saveOptions?.preconditionOpts?.ifGenerationMatch;
              const current = live(path);
              if (precondition === 0 && current) throw apiError(412);
              if (current) current.live = false;
              const version = {
                generation: nextGeneration++,
                bytes: Buffer.from(bytes),
                metadata: saveOptions?.metadata,
                live: true,
                timeCreated: new Date().toISOString(),
              };
              objects.set(path, [...(objects.get(path) ?? []), version]);
              file.metadata = { generation: String(version.generation), size: String(version.bytes.length) };
            },
            async getMetadata() {
              calls.push({ op: 'file.getMetadata', name, generation: pinned });
              fail('file.getMetadata');
              const version = at(path, pinned);
              if (!version) throw apiError(404);
              return [{ generation: String(version.generation), size: String(version.bytes.length) }];
            },
            createReadStream(readOptions = {}) {
              calls.push({ op: 'createReadStream', name, generation: pinned, options: { ...readOptions } });
              const version = at(path, pinned);
              if (failures.createReadStream) {
                const error = failures.createReadStream;
                delete failures.createReadStream;
                return new Readable({
                  read() {
                    this.destroy(error);
                  },
                });
              }
              if (!version) {
                return new Readable({
                  read() {
                    this.destroy(apiError(404));
                  },
                });
              }
              const start = readOptions.start ?? 0;
              if (start >= version.bytes.length && version.bytes.length > 0) {
                return new Readable({
                  read() {
                    this.destroy(apiError(416));
                  },
                });
              }
              const end = readOptions.end === undefined ? version.bytes.length : readOptions.end + 1;
              const slice = version.bytes.subarray(start, end);
              // Emit in small chunks so the streaming cap is exercised.
              const parts = [];
              for (let offset = 0; offset < slice.length; offset += 4) parts.push(slice.subarray(offset, offset + 4));
              return Readable.from(parts);
            },
            async delete(deleteOptions = {}) {
              calls.push({ op: 'delete', name, generation: pinned, options: { ...deleteOptions } });
              fail('delete');
              const version = at(path, pinned);
              if (!version) throw apiError(404);
              if (
                deleteOptions.ifGenerationMatch !== undefined &&
                String(live(path)?.generation) !== String(deleteOptions.ifGenerationMatch)
              )
                throw apiError(412);
              objects.set(
                path,
                objects.get(path).filter(item => item !== version)
              );
            },
          };
          return file;
        },
      };
    },
  };
  return storage;
}

module.exports = { SECRET, apiError, safeBucket, createFakeStorage };
