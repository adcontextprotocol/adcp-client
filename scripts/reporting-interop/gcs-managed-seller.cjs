'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
async function main() {
  const { createFixture } = require('./managed-seller.cjs');
  const argv = process.argv.slice(2);
  const upstream = argv[argv.indexOf('--upstream') + 1];
  const installLock = argv[argv.indexOf('--package-lock') + 1];
  const req = createRequire(path.resolve(path.dirname(installLock), 'package.json'));
  const privateFile = process.env.REPORTING_INTEROP_GCS_INPUT;
  if ((fs.statSync(privateFile).mode & 0o777) !== 0o600) throw new Error('Private config mode');
  const config = JSON.parse(fs.readFileSync(privateFile));
  const { Storage } = req('@google-cloud/storage');
  const gcs = req('@adcp/sdk/reporting/gcs');
  const storage = new Storage({ projectId: config.project_id, keyFilename: config.adc_path });
  const wrapper = require(
    path.join(path.resolve(upstream), 'scripts/ci/reporting_interop/ts_managed_reporting_server.cjs')
  );
  argv.push('--pg-url', process.env.DATABASE_URL);
  return wrapper.main(argv, {
    createManagedReportingFixture: async (api, pool, options) => {
      const fixture = await createFixture(api, pool, {
        ...options,
        gcs: {
          api: gcs,
          storage,
          bucket: config.bucket,
          namespace: config.namespace,
          contractPrefix: config.namespace + '/contracts/' + options.mode + '/',
        },
      });
      const control = fixture.controller;
      fixture.controller = async (scenario, operation) => {
        const result = await control(scenario, operation);
        if (operation === 'prepare') {
          const scope = {
            principal_id: config.reader_principal,
            account_id: 'reporting_core_lab',
            destination_ref: 'destination-' + options.mode,
            generation: 1,
          };
          const provider = await fixture.managed.getAuthorizedObjectWriteBinding(scope);
          if (!provider || provider.bucket !== config.bucket) throw new Error('Missing destination binding');
          const grant = {
            ...scope,
            bucket: provider.bucket,
            objectPrefix: `adcp-reporting/${provider.namespace_key}/${api.ledger.reportingObjectWriteScopeKey(scope)}/`,
            contractPrefix: config.namespace + '/contracts/' + options.mode + '/',
          };
          grant.outsideObjects = [
            grant.objectPrefix.slice(0, -1) + '-sibling/probe',
            `adcp-reporting/${provider.namespace_key}/outside-scope/probe`,
            grant.contractPrefix.slice(0, -1) + '-sibling/probe',
          ];
          for (const object of grant.outsideObjects)
            await storage
              .bucket(config.bucket)
              .file(object)
              .save(Buffer.from('Owned prefix denial control'), {
                resumable: false,
                preconditionOpts: { ifGenerationMatch: 0 },
              })
              .catch(error => {
                if (Number(error.code) !== 412) throw error;
              });
          grant.compressedObject = grant.contractPrefix + 'compressed-control.bin';
          await storage
            .bucket(config.bucket)
            .file(grant.compressedObject)
            .save(zlib.gzipSync(Buffer.alloc(4096, 97)), {
              resumable: false,
              metadata: { contentEncoding: 'gzip' },
              preconditionOpts: { ifGenerationMatch: 0 },
            })
            .catch(error => {
              if (Number(error.code) !== 412) throw error;
            });
          const grantFile = path.join(process.env.REPORTING_INTEROP_DESTINATION, 'gcs-grant.json');
          const bytes = JSON.stringify(grant) + '\n';
          if (fs.existsSync(grantFile)) {
            if (fs.readFileSync(grantFile, 'utf8') !== bytes) throw new Error('Saved destination binding changed');
          } else fs.writeFileSync(grantFile, bytes, { flag: 'wx', mode: 0o600 });
        }
        return result;
      };
      return fixture;
    },
  });
}
main().catch(error => {
  process.stderr.write(
    JSON.stringify({
      status: 'failed',
      error_type: error.name,
      code: /^[A-Z_0-9]{1,80}$/.test(String(error.code)) ? error.code : undefined,
    }) + '\n'
  );
  process.exitCode = 1;
});
