import type {
  AgentClient,
  SingleAgentClient,
  TaskInfo,
  TaskResult,
  TaskRequestTypeMap,
  TaskResponseTypeMap,
  GetTaskStatusResponse,
  ListTasksResponse,
  SyncCatalogsRequest,
  SyncCatalogsResponse,
  SearchBrandsResponse,
  VerifyBrandClaimsRequest,
  VerifyBrandClaimsResponse,
  BuildCreativeRequest,
  ListCreativeFormatsRequest,
  ListContentStandardsRequest,
  GetMediaBuyArtifactsRequest,
  GetCreativeFeaturesRequest,
  GetRightsRequest,
  AcquireRightsRequest,
  UpdateRightsRequest,
} from '../../../dist/lib';
import type * as Manifest from '../../../dist/lib/types/manifest.generated';

type ToolArray = (typeof Manifest)[Extract<keyof typeof Manifest, `${string}_TOOLS_FROM_MANIFEST`>];
type Tool = ToolArray[number];
type Camel<S extends string> = S extends `${infer Head}_${infer Tail}` ? `${Head}${Capitalize<Camel<Tail>>}` : S;
type Assert<T extends true> = T;
type AllAgentMethods = Assert<Exclude<Camel<Tool>, keyof AgentClient> extends never ? true : false>;
type AllSingleMethods = Assert<Exclude<Camel<Tool>, keyof SingleAgentClient> extends never ? true : false>;
type AllRequests = Assert<Exclude<Tool, keyof TaskRequestTypeMap> extends never ? true : false>;
type AllResponses = Assert<Exclude<Tool, keyof TaskResponseTypeMap> extends never ? true : false>;
type Usable<T extends unknown[]> = T extends [infer Head, ...infer Tail]
  ? [Head] extends [never]
    ? false
    : Usable<Tail>
  : true;
type PublicWireTypes = Assert<
  Usable<
    [
      BuildCreativeRequest,
      ListCreativeFormatsRequest,
      ListContentStandardsRequest,
      GetMediaBuyArtifactsRequest,
      GetCreativeFeaturesRequest,
      GetRightsRequest,
      AcquireRightsRequest,
      UpdateRightsRequest,
    ]
  >
>;

declare const agent: AgentClient;
declare const single: SingleAgentClient;
declare const catalogs: Omit<SyncCatalogsRequest, 'idempotency_key'>;
declare const claims: VerifyBrandClaimsRequest;

for (const client of [agent, single]) {
  const status: Promise<TaskResult<GetTaskStatusResponse>> = client.getTaskStatus({ task_id: 'work' });
  const mapped: Promise<TaskInfo> = client.getTaskStatus('work');
  const local: Promise<TaskInfo[]> = client.listTasks();
  const remote: Promise<TaskResult<ListTasksResponse>> = client.listTasks({});
  const synced: Promise<TaskResult<SyncCatalogsResponse>> = client.syncCatalogs(catalogs);
  const found: Promise<TaskResult<SearchBrandsResponse>> = client.searchBrands({ query: 'brand' });
  const verified: Promise<TaskResult<VerifyBrandClaimsResponse>> = client.verifyBrandClaims(claims);
  const generic: Promise<TaskResult<GetTaskStatusResponse>> = client.executeTask('get_task_status', {
    task_id: 'work',
  });
  void [status, mapped, local, remote, synced, found, verified, generic];
  // @ts-expect-error task_id is required by the typed protocol tool.
  client.getTaskStatus({});
  // @ts-expect-error search terms are typed.
  client.searchBrands({ query: 123 });
  // @ts-expect-error executeTask must keep the tool-specific request shape.
  client.executeTask('get_task_status', { task_id: 123 });
}
