"""Two-stage experiment: choose on development, freeze, then open heldout results."""
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
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'round2'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from spike import POLICY,transport,validate
from engine import request_for as old_request,pool,retrieve,url_identity
from cases import development,heldout
ROOT=Path(__file__).parent
CANDIDATES=[
 {'name':'sourced_strict','identity_floor':.7,'evidence_probability':.95,'support_probability':.95},
 {'name':'sourced_balanced','identity_floor':.6,'evidence_probability':.9,'support_probability':.9},
 {'name':'sourced_loose','identity_floor':.5,'evidence_probability':.8,'support_probability':.8},
]
SUPPORT_INSTRUCTION=(POLICY+'Does the supplied context directly support the proposition that BOTH evaluated records represent one entity? '
 'Require an explicit, well-supported identity link such as a registration-preserving rename, a person identifying both names/accounts as their own, '
 'or reliable matching complete identity URLs. A source about a third entity does not establish this pair. '
 'Rumors, questions, jokes, proposed future changes, copied unsupported enrichment, common branding and acquisition/ownership alone do not suffice. '
 'An unresolved correction, disputed match, reassigned identifier or contradictory current primary source prevents a supported identity conclusion. '
 'Assess the supplied evidence independently; you cannot consume other question answers.')


def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True).encode()).hexdigest()


def request_for(case):
    request=old_request(case,POLICY)
    request['questions'].append({'type':'predicate','name':'supported_identity_link','instructions':SUPPORT_INSTRUCTION})
    if len(json.dumps(request['questions'],ensure_ascii=False).encode())>8192:raise ValueError('questions_exceed_budget')
    return request


def assess(body,request,policy):
    answers=validate(body,request)
    data=json.loads(request['input']);left,right=data['records'];identity=answers['identity']
    same=next(p['probability'] for p in identity['probabilities'] if p['value']=='same_entity')
    ev=answers.get('identity_evidence',{});ref=ev.get('choice','none')
    ref_probability=next((p['probability'] for p in ev.get('probabilities',[]) if p['value']==ref),0)
    refs={f['ref'] for f in data['facts']}
    ap,bp=[url_identity(r.get('linkedin')) for r in [left,right]]
    aw,bw=[url_identity(r.get('website')) for r in [left,right]]
    exact=bool(ap and ap==bp and ap.startswith('linkedin.com/company/') and aw and aw==bw)
    conflict=bool(ap and bp and ap!=bp)
    distinct=answers['explicit_distinct']['probability']
    support=answers['supported_identity_link']['probability']
    omitted=any(n>0 for n in data['omitted'].values())
    semantic=ref!='none' and ref in refs
    if policy['name']=='baseline_090':
        publish=identity['choice']=='same_entity' and same>=.9 and (exact or semantic) and distinct<.1 and not conflict
        route='source' if semantic else 'exact'
    else:
        semantic=semantic and ref_probability>=policy['evidence_probability']
        exact=exact and same>=.9
        route='source' if semantic else 'exact'
        publish=identity['choice']=='same_entity' and same>=policy['identity_floor'] and (semantic or exact) and support>=policy['support_probability'] and distinct<.1 and not conflict and not omitted
    return {'publish':bool(publish),'route':route if publish else None,'reference':ref if publish and route=='source' else None,
            'same_probability':same,'evidence_probability':ref_probability,'support_probability':support,'distinct_probability':distinct,'conflict':conflict,'omitted_context':omitted,
            'explanation':({'template':'sourced_identity','ref':ref} if route=='source' else {'template':'exact_profile_website'}) if publish else None}


def metric(rows,results,policy,retrieved):
    by_id={r['id']:r for r in results if r.get('variant','forward')=='forward'}
    candidate_pairs={tuple(sorted((c['a'],c['b']))) for c in retrieved['candidates']}
    m={'pairs':len(rows),'duplicates':sum(c['duplicate'] for c in rows),'negatives':sum(not c['duplicate'] for c in rows),'tp':0,'fp':0,'unsupported_explanations':0,'api_failures':0,'retrieved_duplicates':0,'end_to_end_tp':0,'end_to_end_fp':0,'errors':[]}
    for case in rows:
        pair=tuple(sorted(r['id'] for r in case['records']));found=pair in candidate_pairs
        m['retrieved_duplicates']+=int(case['duplicate'] and found)
        result=by_id.get(case['id'])
        if not result or not result['result']['ok']:m['api_failures']+=1;continue
        assessment=assess(result['result']['attempts'][-1]['body'],result['request'],policy)
        publish=assessment['publish'];correct_explanation=not publish or (case['duplicate'] and (assessment['route']=='exact' or assessment['reference'] in case['gold_support']))
        m['tp']+=int(publish and case['duplicate']);m['fp']+=int(publish and not case['duplicate']);m['unsupported_explanations']+=int(not correct_explanation)
        m['end_to_end_tp']+=int(publish and case['duplicate'] and found);m['end_to_end_fp']+=int(publish and not case['duplicate'] and found)
        if (case['duplicate'] and not publish) or (publish and not case['duplicate']) or not correct_explanation:m['errors'].append({'id':case['id'],'duplicate':case['duplicate'],'retrieved':found,'assessment':assessment})
    m['publication_recall']=m['tp']/m['duplicates'] if m['duplicates'] else None
    m['end_to_end_recall']=m['end_to_end_tp']/m['duplicates'] if m['duplicates'] else None
    m['precision']=m['tp']/(m['tp']+m['fp']) if m['tp']+m['fp'] else None
    return m


def evaluate(rows,path,variants=False):
    if path.exists():return [json.loads(line) for line in path.read_text().splitlines()]
    key=os.environ.get('OPENAI_API_KEY')
    if not key:raise SystemExit('Existing operator OPENAI_API_KEY required')
    jobs=[(case,'forward',request_for(case)) for case in rows]
    if variants:
        subset=[]
        for label in [True,False]:subset.extend(sorted([c for c in rows if c['duplicate']==label],key=lambda c:digest(c['id']))[:6])
        for case in subset:
            swapped={**case,'records':list(reversed(case['records'])),'history':list(reversed(case['history']))}
            jobs.extend([(case,'reverse',request_for(swapped)),(case,'repeat',request_for(case))])
    reserve=sum(len(json.dumps(r).encode())+1024 for _,_,r in jobs)*2*.125/1e6
    if len(jobs)>80 or reserve>.3:raise SystemExit('Phase run/spend reservation exceeded')
    def one(job):
        case,variant,request=job;result=transport(request,key)
        return {'id':case['id'],'variant':variant,'request':request,'result':result}
    results=[]
    with path.open('x') as handle,ThreadPoolExecutor(max_workers=6) as workers:
        for i,result in enumerate(workers.map(one,jobs),1):
            handle.write(json.dumps(result,ensure_ascii=False)+'\n');handle.flush();results.append(result)
            if i%12==0:print(f'{path.stem}: {i}/{len(jobs)} complete',flush=True)
    return results


def main():
    parser=argparse.ArgumentParser();parser.add_argument('phase',choices=['prepare','development','heldout','analyze']);args=parser.parse_args()
    out=ROOT/'results';out.mkdir(exist_ok=True)
    dev=development();test=heldout();datasets={'development':dev,'heldout':test}
    protocol={'version':'evidence-round3-v1','frozen_at':datetime.now(timezone.utc).isoformat(),'datasets':{s:digest(r) for s,r in datasets.items()},'requests':{s:digest([request_for(c) for c in rows]) for s,rows in datasets.items()},'candidate_policies':CANDIDATES,'selection':'first policy in strict-to-loose order with zero false/unsupported suggestions and >=80% development publication recall; otherwise highest safe development recall, strictest tie','max_phase_calls':80,'max_phase_attempts':160,'max_phase_reserved_usd':.3,'no_production_changes':True}
    p=out/'protocol.json'
    if p.exists():
        saved=json.loads(p.read_text());assert saved['datasets']==protocol['datasets'] and saved['requests']==protocol['requests'],'Frozen fixtures or requests changed'
    else:p.write_text(json.dumps(protocol,indent=2)+'\n')
    for split,rows in datasets.items():(ROOT/(split+'.json')).write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
    retrieval={s:{mode:retrieve(pool(rows),mode) for mode in ['current','history']} for s,rows in datasets.items()}
    (out/'retrieval.json').write_text(json.dumps(retrieval,indent=2)+'\n')
    if args.phase=='prepare':print(json.dumps({'prepared':True,'datasets':{s:{'pairs':len(r),'duplicates':sum(c['duplicate'] for c in r)} for s,r in datasets.items()}}));return
    dev_path=out/'development.jsonl';selection=out/'selected-policy.json'
    if args.phase=='development':
        results=evaluate(dev,dev_path)
        if selection.exists():raise SystemExit('Development policy selection already frozen')
        measured=[{'policy':policy,'metrics':metric(dev,results,policy,retrieval['development']['history'])} for policy in CANDIDATES]
        qualified=[r for r in measured if r['metrics']['fp']==0 and r['metrics']['unsupported_explanations']==0 and r['metrics']['publication_recall']>=.8]
        safe=[r for r in measured if r['metrics']['fp']==0 and r['metrics']['unsupported_explanations']==0]
        chosen=qualified[0] if qualified else max(safe,key=lambda r:r['metrics']['tp']) if safe else None
        frozen={'selected_at':datetime.now(timezone.utc).isoformat(),'development_results_sha256':hashlib.sha256(dev_path.read_bytes()).hexdigest(),'candidates':measured,'selected':chosen,'development_gate_passed':bool(qualified)}
        selection.write_text(json.dumps(frozen,indent=2)+'\n');print(json.dumps(frozen,indent=2));return
    if not selection.exists():raise SystemExit('Freeze development selection before opening heldout results')
    chosen=json.loads(selection.read_text())['selected']
    if chosen is None:raise SystemExit('No safe development policy; heldout not evaluated')
    test_path=out/'heldout.jsonl'
    if args.phase=='heldout':evaluate(test,test_path,variants=True)
    if not test_path.exists():raise SystemExit('Heldout results not available')
    results={s:[json.loads(line) for line in (out/(s+'.jsonl')).read_text().splitlines()] for s in ['development','heldout']}
    analysis={'selected_policy':chosen['policy'],'splits':{}}
    for split,rows in datasets.items():
        analysis['splits'][split]={}
        for pname,policy in [('baseline_090',{'name':'baseline_090'}),('evidence_aware',chosen['policy'])]:
            analysis['splits'][split][pname]=metric(rows,results[split],policy,retrieval[split]['history'])
    index={(r['id'],r['variant']):r for r in results['heldout']}
    comparisons={}
    for variant in ['reverse','repeat']:
        measured=[]
        for (id,v),r in index.items():
            if v!=variant:continue
            original=index[(id,'forward')]
            if not original['result']['ok'] or not r['result']['ok']:continue
            a,b=[assess(x['result']['attempts'][-1]['body'],x['request'],chosen['policy']) for x in [original,r]]
            labela,labelb=[x['result']['attempts'][-1]['body']['answers'][0]['choice'] for x in [original,r]]
            measured.append({'id':id,'publication_changed':a['publish']!=b['publish'],'identity_label_changed':labela!=labelb})
        comparisons[variant]={'n':len(measured),'publication_changed':sum(x['publication_changed'] for x in measured),'label_changed':sum(x['identity_label_changed'] for x in measured),'details':[x for x in measured if x['publication_changed'] or x['identity_label_changed']]}
    analysis['stability']=comparisons
    all_results=results['development']+results['heldout'];usage={'input_tokens':0,'cached_tokens':0,'cache_write_tokens':0};latencies=[]
    for r in all_results:
        latencies.append(sum(a['latency_ms'] for a in r['result']['attempts']))
        for attempt in r['result']['attempts']:
            u=attempt.get('body',{}).get('usage',{});usage['input_tokens']+=u.get('input_tokens',0)
            for k in ['cached_tokens','cache_write_tokens']:usage[k]+=u.get('input_tokens_details',{}).get(k,0)
    usage['estimated_usd']=((usage['input_tokens']-usage['cached_tokens']-usage['cache_write_tokens'])*.1+usage['cached_tokens']*.01+usage['cache_write_tokens']*.125)/1e6
    latencies.sort();analysis['operations']={'requests':len(all_results),'failures':sum(not r['result']['ok'] for r in all_results),'usage':usage,'p50_ms':latencies[int((len(latencies)-1)*.5)],'p95_ms':latencies[int((len(latencies)-1)*.95)]}
    (out/'analysis.json').write_text(json.dumps(analysis,indent=2)+'\n')
    print(json.dumps(analysis,indent=2))

if __name__=='__main__':main()
