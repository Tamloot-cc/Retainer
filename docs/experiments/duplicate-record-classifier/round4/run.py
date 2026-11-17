"""Frozen fact-retrieval experiment; baseline classifier unchanged from Round 2."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'round2'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from spike import POLICY,transport,validate
from engine import pool,retrieve,request_for,publication
from corpus import build
from retrieval import source_pool,fact_mentions
ROOT=Path(__file__).parent


def digest(obj):return hashlib.sha256(json.dumps(obj,sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--live',action='store_true');args=parser.parse_args()
    rows=build();out=ROOT/'results';out.mkdir(exist_ok=True)
    requests=[request_for(c,POLICY) for c in rows]
    protocol={'version':'fact_mentions_v1','created_at':datetime.now(timezone.utc).isoformat(),'dataset_sha256':digest(rows),'requests_sha256':digest(requests),'retrieval_policy':{'fts':'simple phrase over full normalized record names','per_fact_owner_candidates':3,'global_fact_pair_cap':200,'no_external_research':True},'classification_policy':'round2 baseline 0.90, unchanged','max_requests':32,'max_attempts':64,'max_reserved_usd':.15}
    p=out/'protocol.json'
    if p.exists():
        saved=json.loads(p.read_text());assert saved['dataset_sha256']==protocol['dataset_sha256'] and saved['requests_sha256']==protocol['requests_sha256'],'Frozen input changed'
    else:p.write_text(json.dumps(protocol,indent=2)+'\n')
    (ROOT/'fixtures.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
    retrieval={}
    for split in ['development','heldout']:
        subset=[r for r in rows if r['split']==split];records,facts=source_pool(subset)
        existing=retrieve(pool(subset),'history');lexical=fact_mentions(records,facts)
        current_pairs={(c['a'],c['b']) for c in existing['candidates']};fact_pairs={(c['a'],c['b']) for c in lexical['candidates']}
        retrieval[split]={'existing':existing,'fact_mentions':lexical,'union_pairs':[list(p) for p in sorted(current_pairs|fact_pairs)]}
    (out/'retrieval.json').write_text(json.dumps(retrieval,indent=2)+'\n')
    path=out/'evaluations.jsonl'
    if args.live:
        if path.exists():raise SystemExit('Results exist; refusing overwrite')
        key=os.environ.get('OPENAI_API_KEY')
        if not key:raise SystemExit('Operator OPENAI_API_KEY required')
        reserve=sum(len(json.dumps(r).encode())+1024 for r in requests)*2*.125/1e6
        if len(requests)>32 or reserve>.15:raise SystemExit('Run/spend budget exceeded')
        def one(item):
            row,request=item;result=transport(request,key)
            return {'id':row['id'],'request':request,'result':result}
        with path.open('x') as handle,ThreadPoolExecutor(max_workers=6) as workers:
            for i,r in enumerate(workers.map(one,zip(rows,requests)),1):
                handle.write(json.dumps(r,ensure_ascii=False)+'\n');handle.flush()
                if i%8==0:print(f'Completed {i}/32',flush=True)
    if not path.exists():print(json.dumps({'frozen':True,'pairs':32,'retrieval':{s:{'existing':len(r['existing']['candidates']),'fact_pairs':len(r['fact_mentions']['candidates']),'union':len(r['union_pairs'])} for s,r in retrieval.items()}}));return
    results=[json.loads(line) for line in path.read_text().splitlines()];lookup={r['id']:r for r in results};analysis={}
    for split in ['development','heldout']:
        subset=[c for c in rows if c['split']==split];r=retrieval[split]
        existing={(c['a'],c['b']) for c in r['existing']['candidates']};extended={tuple(p) for p in r['union_pairs']}
        declared={tuple(sorted(x['id'] for x in c['records'])) for c in subset}
        m={'pairs':len(subset),'positives':sum(c['duplicate'] for c in subset),'negatives':sum(not c['duplicate'] for c in subset),'existing_candidates':len(existing),'extended_candidates':len(extended),'cross_story_candidates':len(extended-declared),'existing_positives_retrieved':0,'extended_positives_retrieved':0,'classifier_tp_if_all_evaluated':0,'classifier_fp_if_all_evaluated':0,'unsupported_explanations':0,'existing_end_to_end_tp':0,'extended_end_to_end_tp':0,'extended_end_to_end_fp':0,'misses':[]}
        for case in subset:
            pair=tuple(sorted(x['id'] for x in case['records']));found=pair in extended;old=pair in existing
            m['existing_positives_retrieved']+=int(case['duplicate'] and old);m['extended_positives_retrieved']+=int(case['duplicate'] and found)
            result=lookup[case['id']]
            pub=publication(result['result']['attempts'][-1]['body'],result['request'],validate,.9) if result['result']['ok'] else {'publish':False,'explanation':None}
            publish=pub['publish'];m['classifier_tp_if_all_evaluated']+=int(publish and case['duplicate']);m['classifier_fp_if_all_evaluated']+=int(publish and not case['duplicate'])
            explanation=pub['explanation'];unsupported=publish and (not case['duplicate'] or (explanation['template']=='sourced_identity' and explanation['ref'] not in case['gold_support']))
            m['unsupported_explanations']+=int(unsupported);m['existing_end_to_end_tp']+=int(case['duplicate'] and old and publish);m['extended_end_to_end_tp']+=int(case['duplicate'] and found and publish);m['extended_end_to_end_fp']+=int(not case['duplicate'] and found and publish)
            if case['duplicate'] and not (found and publish):m['misses'].append({'id':case['id'],'retrieved':found,'publication':pub})
        analysis[split]=m
    tokens=sum(a.get('body',{}).get('usage',{}).get('input_tokens',0) for r in results for a in r['result']['attempts']);lat=sorted(sum(a['latency_ms'] for a in r['result']['attempts']) for r in results)
    analysis['operations']={'requests':len(results),'failures':sum(not r['result']['ok'] for r in results),'input_tokens':tokens,'estimated_uncached_usd':tokens*.1/1e6,'p50_ms':lat[int((len(lat)-1)*.5)],'p95_ms':lat[int((len(lat)-1)*.95)]}
    (out/'analysis.json').write_text(json.dumps(analysis,indent=2)+'\n');print(json.dumps(analysis,indent=2))

if __name__=='__main__':main()
