"""Round 2 frozen-protocol evaluation. Synthetic raw outputs only in repository."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import time
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from spike import POLICY,transport,validate
from cases import build
from engine import pool,retrieve,request_for,publication
ROOT=Path(__file__).parent


def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True).encode()).hexdigest()


def explain_correct(row,pub):
    if not pub['publish']:return True
    explanation=pub['explanation']
    if explanation['template']=='sourced_identity':return explanation['ref'] in row['gold_support']
    # Exact-match explanation is checkable, but is unsupported if synthetic truth says distinct.
    return row['duplicate']


def metrics(rows,results,retrieval,threshold):
    lookup={r['id']:r for r in results}
    pairs={tuple(sorted((c['a'],c['b']))) for c in retrieval['candidates']}
    stats={}
    for split in ['development','heldout','all']:
        subset=[r for r in rows if split=='all' or r['split']==split]
        m={'pairs':len(subset),'duplicates':sum(r['duplicate'] for r in subset),'negatives':sum(not r['duplicate'] for r in subset),'api_failures':0,'tp':0,'fp':0,'unsupported':0,'duplicates_retrieved':0,'end_to_end_tp':0,'end_to_end_fp':0,'abstentions':0,'contradictions':0,'errors':[]}
        for row in subset:
            retrieved=tuple(sorted(r['id'] for r in row['records'])) in pairs
            m['duplicates_retrieved']+=int(retrieved and row['duplicate'])
            result=lookup.get(row['id'])
            if not result or not result['result']['ok']:m['api_failures']+=1;continue
            pub=publication(result['result']['attempts'][-1]['body'],result['request'],validate,threshold)
            label=result['result']['attempts'][-1]['body']['answers'][0]['choice']
            m['tp']+=int(pub['publish'] and row['duplicate']);m['fp']+=int(pub['publish'] and not row['duplicate'])
            m['end_to_end_tp']+=int(retrieved and pub['publish'] and row['duplicate']);m['end_to_end_fp']+=int(retrieved and pub['publish'] and not row['duplicate'])
            m['unsupported']+=int(not explain_correct(row,pub));m['abstentions']+=int(label=='insufficient_evidence');m['contradictions']+=int(pub['contradictory'])
            if (pub['publish'] and not row['duplicate']) or (not pub['publish'] and row['duplicate']):m['errors'].append({'id':row['id'],'label':label,'publication':pub,'retrieved':retrieved})
        m['precision']=m['tp']/(m['tp']+m['fp']) if m['tp']+m['fp'] else None
        m['classification_recall']=m['tp']/m['duplicates'] if m['duplicates'] else None
        m['retrieval_recall']=m['duplicates_retrieved']/m['duplicates'] if m['duplicates'] else None
        m['end_to_end_recall']=m['end_to_end_tp']/m['duplicates'] if m['duplicates'] else None
        stats[split]=m
    return stats


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--live',action='store_true');parser.add_argument('--analyze',action='store_true');args=parser.parse_args()
    rows=build();out=ROOT/'results';out.mkdir(exist_ok=True)
    # Include all 80 specified pairs to measure classifier quality independent of retrieval.
    # Score candidate generation over the entire 160-record pool, not one pair at a time.
    retrieval={mode:retrieve(pool(rows),mode) for mode in ['host','current','history']}
    declared={tuple(sorted(r['id'] for r in c['records'])) for c in rows}
    record_sources={r['id']:(c,i) for c in rows for i,r in enumerate(c['records'])}
    for candidate in retrieval['history']['candidates']:
        pair=(candidate['a'],candidate['b'])
        if pair in declared:continue
        lc,li=record_sources[pair[0]];rc,ri=record_sources[pair[1]]
        # Separate fixture stories describe distinct entities. Cross-story matches are negatives by construction.
        split='heldout' if lc['split']=='heldout' or rc['split']=='heldout' else 'development'
        facts=[{**f,'ref':prefix+'_'+f['ref']} for prefix,c in [('left',lc),('right',rc)] for f in c['facts']]
        rows.append({'id':'cross-'+hashlib.sha256(('|'.join(pair)).encode()).hexdigest()[:12],'split':split,'duplicate':False,'kind':lc['kind'],'records':[lc['records'][li],rc['records'][ri]],'history':[lc['history'][li],rc['history'][ri]],'facts':facts,'gold_support':[],'cross_story':True})
    requests=[request_for(row,POLICY) for row in rows]
    (out/'retrieval.json').write_text(json.dumps(retrieval,indent=2)+'\n')
    (ROOT/'fixtures.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
    protocol={'version':'round2-frozen-v2','frozen_at':datetime.now(timezone.utc).isoformat(),'dataset_sha256':digest(rows),'requests_sha256':digest(requests),'policy_sha256':digest(POLICY),'primary_threshold':.9,'baseline_threshold':.95,'context_max_utf8_bytes':8192,'question_max_utf8_bytes':8192,'max_requests':140,'max_attempts':280,'timeout_seconds':20,'retries':1,'max_spend_reservation_usd':.30,'retrieval_modes':list(retrieval),'production_changes':False}
    protocol_file=out/'protocol.json'
    if protocol_file.exists():
        saved=json.loads(protocol_file.read_text())
        assert saved['dataset_sha256']==protocol['dataset_sha256'] and saved['requests_sha256']==protocol['requests_sha256'],'Frozen fixtures or questions changed'
    else:protocol_file.write_text(json.dumps(protocol,indent=2)+'\n')
    path=out/'evaluations.jsonl'
    if args.live:
        if path.exists():raise SystemExit('Outputs already exist; not overwriting or tuning after holdout')
        key=os.environ.get('OPENAI_API_KEY')
        if not key:raise SystemExit('Operator OPENAI_API_KEY required')
        reservation=sum(len(json.dumps(q).encode())+1024 for q in requests)*2*.125/1e6
        if reservation>.30:raise SystemExit('Spend reservation exceeded')
        started=time.monotonic()
        def run(item):
            row,request=item
            result=transport(request,key)
            return {'id':row['id'],'request':request,'result':result,'latency_ms':round((time.monotonic()-started)*1000)}
        with path.open('x') as handle,ThreadPoolExecutor(max_workers=6) as workers:
            for i,result in enumerate(workers.map(run,zip(rows,requests)),1):
                handle.write(json.dumps(result,ensure_ascii=False)+'\n');handle.flush()
                if i%20==0:print(f'Completed {i}/{len(rows)}',flush=True)
        print('Wall seconds:',round(time.monotonic()-started,2),flush=True)
    if not path.exists():
        print(json.dumps({'frozen':True,'pairs':len(rows),'retrieval_candidates':{k:v['total_candidates'] for k,v in retrieval.items()}}));return
    results=[json.loads(line) for line in path.read_text().splitlines()]
    analysis={str(t):{mode:metrics(rows,results,retrieved,t) for mode,retrieved in retrieval.items()} for t in [.9,.95]}
    attempts=[a for r in results for a in r['result']['attempts']]
    usage={'input_tokens':0,'cached_tokens':0,'cache_write_tokens':0}
    latency=[]
    for r in results:
        latency.append(sum(a['latency_ms'] for a in r['result']['attempts']))
        for attempt in r['result']['attempts']:
            u=attempt.get('body',{}).get('usage',{})
            usage['input_tokens']+=u.get('input_tokens',0)
            for k in ['cached_tokens','cache_write_tokens']:usage[k]+=u.get('input_tokens_details',{}).get(k,0)
    usage['estimated_usd']=((usage['input_tokens']-usage['cached_tokens']-usage['cache_write_tokens'])*.1+usage['cached_tokens']*.01+usage['cache_write_tokens']*.125)/1e6
    latency.sort()
    analysis['operations']={'requests':len(results),'attempts':len(attempts),'failures':sum(not r['result']['ok'] for r in results),'usage':usage,'p50_ms':latency[int((len(latency)-1)*.5)],'p95_ms':latency[int((len(latency)-1)*.95)]}
    (out/'analysis.json').write_text(json.dumps(analysis,indent=2)+'\n')
    print(json.dumps({'operations':analysis['operations'],'primary':{m:{s:{k:v for k,v in d.items() if k!='errors'} for s,d in analysis['0.9'][m].items()} for m in retrieval}},indent=2))

if __name__=='__main__':main()
