import asyncio, json, os
from adcp import ADCPClient, AgentConfig
from adcp.types import Protocol, ComplyTestControllerRequest
async def main():
 config=AgentConfig(id='gcs-preflight',name='gcs-preflight',agent_uri=os.environ['GCS_PREFLIGHT_URL'],protocol=Protocol.MCP,auth_token=os.environ['ADCP_INTEROP_BUYER_TOKEN'],auth_header='Authorization',auth_type='bearer')
 async with ADCPClient(config,adcp_version=os.environ['GCS_PREFLIGHT_VERSION']) as client:
  mode=os.environ['GCS_PREFLIGHT_MODE'];scenario=f"reliable_reporting_{'reconciled_billing' if mode=='billing' else 'managed_delivery'}_probe"
  result=await client.comply_test_controller(ComplyTestControllerRequest.model_validate({'account':{'brand':{'domain':'reporting.example.test'},'operator':'test.example','sandbox':True},'scenario':scenario,'params':{'operation':'prepare'}}))
  if result.status.value!='completed':raise ValueError('preflight did not complete')
 print(json.dumps({'status':'passed','official_mcp_prepared':True}))
try:asyncio.run(main())
except Exception as error:print(json.dumps({'status':'failed','error_type':type(error).__name__}));raise SystemExit(1)
