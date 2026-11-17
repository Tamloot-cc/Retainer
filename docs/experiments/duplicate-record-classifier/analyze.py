"""Analyze frozen outputs, including read-only pg_trgm candidate coverage."""
import json
from pathlib import Path
import subprocess
from urllib.parse import urlsplit
from spike import ROOT, fixtures, summarize

rows=fixtures()
results=[json.loads(line) for line in (ROOT/'results/evaluations.jsonl').read_text().splitlines()]
# Read-only query over inline synthetic labels; no Retainer tables are read or written.
labels=[{'id':r['id'],'a':r['records'][0]['name'],'b':r['records'][1]['name']} for r in rows]
sql="BEGIN READ ONLY; SELECT json_agg(json_build_object('id',r->>'id','similarity',similarity(r->>'a',r->>'b'))) FROM json_array_elements($pairs$"+json.dumps(labels)+"$pairs$::json) r; ROLLBACK;"
proc=subprocess.run(['docker','exec','-i','docker-postgres-1','psql','-U','retainer','-d','retainer','-Atq','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True,check=True)
similarities={r['id']:r['similarity'] for r in json.loads(proc.stdout)}

def identifiers(record, full):
    found=set()
    for key in ['website','linkedin']:
        if record.get(key):
            url=urlsplit(record[key])
            host=url.hostname.lower().removeprefix('www.')
            if full:
                # Prototype exact identity comparator; no tracking-query normalization is tested here.
                value=host+url.path.rstrip('/')+('?' + url.query if url.query else '')
                if key=='linkedin' and not url.path.strip('/'):
                    continue
            else:
                value=host
            found.add(('url',value))
    for key in ['email','phone']:
        if record.get(key):found.add((key,record[key].strip().lower()))
    return found

lookup={r['id']:r for r in results if r['variant']=='full' and r['multiple'] and not r['reverse'] and not r['repeat']}
coverage={}
for mode,full in [('current_hostnames',False),('prototype_full_urls',True)]:
    pairs=[]
    for row in rows:
        a,b=row['records']
        shared=bool(identifiers(a,full)&identifiers(b,full))
        retrieved=shared or similarities[row['id']]>=.6
        pairs.append({'id':row['id'],'kind':row['kind'],'duplicate':row['duplicate'],'retrieved':retrieved,
                      'similarity':similarities[row['id']], 'shared_identifier':shared,
                      'published':lookup[row['id']].get('publication',{}).get('publish',False)})
    coverage[mode]={'retrieved':sum(r['retrieved'] for r in pairs),
                    'duplicates_retrieved':sum(r['retrieved'] and r['duplicate'] for r in pairs),
                    'nonduplicates_retrieved':sum(r['retrieved'] and not r['duplicate'] for r in pairs),
                    'end_to_end_duplicates_published':sum(r['retrieved'] and r['duplicate'] and r['published'] for r in pairs),
                    'missed_duplicates':[r['id'] for r in pairs if r['duplicate'] and not r['retrieved']], 'pairs':pairs}
summary=summarize(results)
summary['retrieval']=coverage
usage={'input_tokens':0,'cached_tokens':0,'cache_write_tokens':0}
latencies=[]
for r in results:
    for attempt in r['result']['attempts']:
        u=attempt.get('body',{}).get('usage',{})
        usage['input_tokens']+=u.get('input_tokens',0)
        for k in ['cached_tokens','cache_write_tokens']:usage[k]+=u.get('input_tokens_details',{}).get(k,0)
    if r['result']['ok']:latencies.append(sum(a['latency_ms'] for a in r['result']['attempts']))
usage['estimated_usd']=(usage['input_tokens']-usage['cached_tokens']-usage['cache_write_tokens'])*.1/1e6+usage['cached_tokens']*.01/1e6+usage['cache_write_tokens']*.125/1e6
usage['billing_verified']=False
latencies.sort()
summary['usage']=usage
summary['p50_ms']=latencies[int((len(latencies)-1)*.5)]
summary['p95_ms']=latencies[int((len(latencies)-1)*.95)]
(ROOT/'results/analysis.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({'usage':usage,'p50_ms':summary['p50_ms'],'p95_ms':summary['p95_ms'],'retrieval':{k:{a:b for a,b in v.items() if a!='pairs'} for k,v in coverage.items()},'comparisons':summary['comparisons']},indent=2))
for key,g in summary['groups'].items():
    print(key,{k:v for k,v in g.items() if k!='by_kind'})

# Frozen policy sensitivity: development first; heldout remains same-template validation.
sensitivity={}
from spike import publication
for threshold in [.85,.9,.95,.98]:
    sensitivity[str(threshold)]={}
    for split in ['development','heldout']:
        subset=[r for r in lookup.values() if r['split']==split]
        pubs=[(r,publication(r['result']['attempts'][-1]['body'],r['request'],threshold)['publish']) for r in subset]
        sensitivity[str(threshold)][split]={'tp':sum(p and r['duplicate'] for r,p in pubs),'fp':sum(p and not r['duplicate'] for r,p in pubs),'duplicates':sum(r['duplicate'] for r,p in pubs)}
summary['threshold_sensitivity']=sensitivity
for comparison,transform in [('order',('full',True,True,0)),('repeat',('full',True,False,1))]:
    index={(r['id'],r['variant'],r['multiple'],r['reverse'],r['repeat']):r for r in results}
    compared=[]
    for r in lookup.values():
        other=index.get((r['id'],*transform))
        if other:compared.append((r,other))
    summary['comparisons'][comparison]['publication_changed']=sum(a['publication']['publish']!=b['publication']['publish'] for a,b in compared)
# Total observed usage includes the successful calls in the first, invalid-shape batch and access probe.
all_usage={'input_tokens':0,'cached_tokens':0,'cache_write_tokens':0}
initial=[json.loads(line) for line in (ROOT/'results/initial-schema-error-evaluations.jsonl').read_text().splitlines()]
bodies=[a['body'] for r in results+initial for a in r['result']['attempts'] if 'body' in a]
bodies.append(json.loads((ROOT/'results/access-probe.json').read_text())['response'])
for body in bodies:
    u=body.get('usage',{})
    all_usage['input_tokens']+=u.get('input_tokens',0)
    for k in ['cached_tokens','cache_write_tokens']:all_usage[k]+=u.get('input_tokens_details',{}).get(k,0)
all_usage['estimated_usd']=(all_usage['input_tokens']-all_usage['cached_tokens']-all_usage['cache_write_tokens'])*.1/1e6+all_usage['cached_tokens']*.01/1e6+all_usage['cache_write_tokens']*.125/1e6
summary['all_runs_usage']=all_usage
(ROOT/'results/analysis.json').write_text(json.dumps(summary,indent=2)+'\n')
print('Threshold sensitivity:',json.dumps(sensitivity))
print('All runs usage:',json.dumps(all_usage))
