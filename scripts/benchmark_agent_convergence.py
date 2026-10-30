"""Offline natural Agent convergence benchmark using actual routes and queue.

Use a fresh --data directory and the same interpreter for baseline/current.
All images and configuration are synthetic. preview_session blocks external
sockets and port 8000; upstream calls use MockTransport only. No real latency
or cache hit rate is measured. Importing this script does not start services.
"""


def main(argv=None):
    import argparse, base64, hashlib, io, json, random, sqlite3, sys, threading, time
    from pathlib import Path
    from unittest.mock import patch

    parser=argparse.ArgumentParser(); parser.add_argument('--source',required=True); parser.add_argument('--output',required=True); parser.add_argument('--data',required=True); parser.add_argument('--rounds',type=int,nargs='+',default=[5,17,25,50])
    args=parser.parse_args(argv); source=Path(args.source).resolve(); sys.path.insert(0,str(source))
    if not args.rounds or min(args.rounds)<2 or max(args.rounds)>200: parser.error('round checkpoints must be between 2 and 200')
    data=Path(args.data).resolve()
    if data.exists() and any(data.iterdir()): parser.error('--data must be new or empty; never reuse an existing library')
    source_files=('backend/services/agent_task_state.py','backend/services/agent_context_scope.py','backend/services/agent_execution.py','backend/services/agent_repository.py')
    fingerprints={name:hashlib.sha256((source/name).read_bytes()).hexdigest() for name in source_files}
    from fastapi.testclient import TestClient
    import httpx
    from PIL import Image
    from scripts.preview_agent import preview_session
    from backend.services import agent_execution as execution
    from backend.services.agent_repository import AgentRepository


    def png(index):
        output=io.BytesIO(); Image.frombytes('RGB',(96,96),random.Random(1731+index).randbytes(27648)).save(output,'PNG'); return output.getvalue()


    def hashes(body):
        urls=[p['image_url'] for row in body['input'] for p in row.get('content',[]) if p.get('type')=='input_image']
        return len(urls),{hashlib.sha256(base64.b64decode(url.split(',',1)[1])).hexdigest() for url in urls}


    def message():
        return {'id':'synthetic-answer','type':'message','role':'assistant','content':[{'type':'output_text','text':'Exact synthetic answer; every written constraint remains available.'}]}


    def scenario(name):
        output=[]; prep={}; plans=[]; captured={}; request_id=None
        root=Path(args.data)/name
        with preview_session(root,delay=0,slow_delay=0) as (app,provider,seeds):
          repo=AgentRepository(app.state.library_path)
          original_handle=provider.handle; original_prepare=execution.prepare_context
          def handle(request):
            nonlocal request_id
            raw=request.read(); reply=original_handle(request)
            if request.url.path.endswith('/responses'):
                body=json.loads(raw); occurrences,unique=hashes(body)
                captured[request_id]={'jsonBytes':len(raw),'imageOccurrences':occurrences,'uniqueImages':len(unique),'_hashes':unique}
                assert plans, 'Unexpected extra model POST'
                generate=plans.pop(0)
                if generate:
                    task=provider.task_context(body)
                    selection={'targetRef':task['target']['ref'],'auxiliaries':[]}
                    result=[{'id':'image-tool','type':'function_call','call_id':'image-tool','name':'generate_image_batch',
                        'arguments':json.dumps({'images':[{'id':'one','prompt':'Synthetic geometric image. Preserve explicit written constraints.'}],
                            'referenceSelection':selection,'finish_after_generation':True})}]
                else: result=[message()]
                return httpx.Response(200,json={'id':'synthetic','status':'completed','output':result})
            return reply
          provider.handle=handle
          def prepare(repo_arg,request,*a,**kw):
            connections=[]; counts={'sqlStatements':0,'sqlSelects':0}; tid=threading.get_ident(); original_connect=sqlite3.connect
            def connect(*a,**kw):
                connection=original_connect(*a,**kw)
                if threading.get_ident()==tid:
                    connections.append(connection)
                    def trace(sql):
                        counts['sqlStatements']+=1; counts['sqlSelects']+=int(sql.lstrip().upper().startswith('SELECT'))
                    connection.set_trace_callback(trace)
                return connection
            started=time.perf_counter()
            try:
                with patch.object(sqlite3,'connect',connect): result=original_prepare(repo_arg,request,*a,**kw)
            finally:
                for conn in connections: conn.set_trace_callback(None)
            prep[request['id']]={**counts,'instrumentedPreparationMs':round((time.perf_counter()-started)*1000,3)}
            return result
          with patch.object(execution,'prepare_context',prepare), TestClient(app,base_url='http://127.0.0.1:8766',client=('127.0.0.1',45678)) as client:
            parent=None; target=None; uploaded=[]
            for number in range(1,max(args.rounds)+1):
                request_id=f'{name}-{number}'; refs=[]; generate=False; prompt='Keep the exact written requirement and refine the wording.'
                if number==1: prompt='hello'
                add=(number==2 or name=='A_target_switches' and number>=8 and number%4==0 or name=='C_required_comparison' and number>=6 and number%4==2)
                if add:
                    raw=png(number); response=client.post('/api/agent/uploads',files={'file':(f'synthetic-{number}.png',raw,'image/png')}); assert response.status_code==200,response.text
                    target=response.json()['uploadId'];uploaded.append(target);refs=[{'kind':'upload','uploadId':target}]
                    prompt='Describe this newly supplied geometric target; keep the written constraints.'
                if name=='A_target_switches' and (number==5 or number>=8 and number%4==0): generate=True
                if name=='B_continue_results':
                    if number>=4 and number%4==0: generate=True
                    elif number>=5 and number%4==1: prompt='continue the latest generated image'
                if name=='C_required_comparison' and number>1: prompt='Compare all images of the explicitly selected full branch; each is necessary.'
                if generate: prompt+=' Generate the selected target now.'
                snapshot=client.get('/api/agent/conversations/preview').json();config=client.get('/api/agent/config').json()
                plans.append(generate)
                body={'requestId':request_id,'expectedRevision':snapshot['revision'],'parentRoundId':parent,'prompt':prompt,
                    'refs':refs,'configRevision':config['revision'],'imageCount':1,'contextScope':'branch' if name=='C_required_comparison' else 'task',
                    'authorization':{'scope':'this_request','allowImageGeneration':generate,'maxImageJobs':1 if generate else 0,'maxToolRounds':5}}
                response=client.post('/api/agent/conversations/preview/rounds',json=body);assert response.status_code==202,response.text
                deadline=time.monotonic()+20
                while time.monotonic()<deadline:
                    row=repo.request(request_id)
                    if row['state'] not in {'queued','running','waiting_for_jobs','stop_requested'}:break
                    time.sleep(.01)
                assert row['state']=='completed',(number,row['state'],row['error']);parent=row['round_id']
                context=row['round']['taskContext']; target=(context.get('target') or {}).get('assetId')
                expected=[*uploaded] if name=='C_required_comparison' else ([target] if target else [])
                expected_hashes={hashlib.sha256((repo.library/repo.asset(aid)['path']).read_bytes()).hexdigest() for aid in expected}
                metrics=captured.pop(request_id);actual=metrics.pop('_hashes')
                output.append({'round':number,**metrics,**prep[request_id],
                    'requiredImages':len(expected_hashes),'requiredCoverageComplete':expected_hashes<=actual,
                    'unexpectedUniqueImages':len(actual-expected_hashes),'modelPosts':provider.counts['responses'],
                    'imagePosts':provider.counts['images'],'targetAssetId':target,
                    'dependencyReasons':[d['reason'] for d in context['historyDependencies']],
                    'unresolvedItems':context['unresolvedItems'],'taskType':context['taskType'],
                    'taskStateBytes':len(json.dumps(context,ensure_ascii=False).encode())})
                assert not plans and output[-1]['requiredCoverageComplete'],output[-1]
                if number in args.rounds: print(json.dumps({'scenario':name,**{k:v for k,v in output[-1].items() if k not in {'dependencyReasons','unresolvedItems','targetAssetId'}}}),flush=True)
          assert provider.counts['blocked']==0
        return {'name':name,'rounds':output}

    report={'scope':'Production HTTP routes, worker and image queue; synthetic images; MockTransport only',
     'sourceName':source.name,'sourceSha256':fingerprints,'checkpoints':args.rounds,'timing':'Single instrumented local preparation samples; no real latency/cache claims',
     'counts':'SQL statements/selects within prepare_context only; model/image posts cumulative per scenario',
     'scenarios':[scenario(name) for name in ('A_target_switches','B_continue_results','C_required_comparison')]}
    Path(args.output).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')


if __name__ == '__main__':
    main()
