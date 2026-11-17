"""Artificial shared-prefix billing/cache probe. Never publish these outputs."""
import copy
from datetime import datetime,timezone
import json
import os
from pathlib import Path
from matrix import regressions,digest
from runtime import Budget,transport
ROOT=Path(__file__).parent


def requests():
    base=copy.deepcopy(next(j['request'] for j in regressions() if j['id']=='round4/continuing_entity_rename'))
    context=json.loads(base['input']);context['synthetic_padding']='Office logistics only. No identity evidence in this sentence. '*220
    base['input']=json.dumps(context,ensure_ascii=False,separators=(',',':'));base['prompt_cache_key']='retainer-synthetic-spike-round5-v1'
    single=copy.deepcopy(base);single['questions']=[q for q in single['questions'] if q['name']=='identity']
    changed=copy.deepcopy(single);changed_context=json.loads(changed['input']);changed_context['schema']='Different prefix. '+changed_context['schema'];changed['input']=json.dumps(changed_context,ensure_ascii=False,separators=(',',':'))
    short=copy.deepcopy(single);short['input']=json.dumps({k:v for k,v in context.items() if k!='synthetic_padding'},ensure_ascii=False,separators=(',',':'))
    cases=[('long_single_first',single),('long_single_repeat',single),('long_multi_first',base),('long_multi_repeat',base),('long_single_again',single),('changed_prefix_first',changed),('changed_prefix_repeat',changed),('original_prefix_again',single),('short_prefix_first',short),('short_prefix_repeat',short)]
    return [{'name':n,'request':copy.deepcopy(r)} for n,r in cases]


def main():
    out=ROOT/'results';path=out/'cache-probe.json';jobs=requests();manifest=out/'cache-protocol.json'
    if manifest.exists():assert json.loads(manifest.read_text())['requests_sha256']==digest(jobs)
    else:manifest.write_text(json.dumps({'frozen_at':datetime.now(timezone.utc).isoformat(),'requests_sha256':digest(jobs),'requests':10,'artificial_padding':True,'max_reserved_usd':.15,'publication_allowed':False},indent=2)+'\n')
    if path.exists():raise SystemExit('Cache results exist; not overwriting')
    key=os.environ.get('OPENAI_API_KEY')
    if not key:raise SystemExit('Operator OPENAI_API_KEY required')
    budget=Budget(20,.15);results=[]
    for job in jobs:
        r=transport(job['request'],key,budget);results.append({**job,'result':r});path.write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
    usage={'input_tokens':0,'cached_tokens':0,'cache_write_tokens':0};summary=[]
    for r in results:
        body=r['result']['attempts'][-1].get('body',{});u=body.get('usage',{});details=u.get('input_tokens_details',{})
        usage['input_tokens']+=u.get('input_tokens',0)
        for k in ['cached_tokens','cache_write_tokens']:usage[k]+=details.get(k,0)
        summary.append({'name':r['name'],'ok':r['result']['ok'],'input_tokens':u.get('input_tokens'),'cached_tokens':details.get('cached_tokens'),'cache_write_tokens':details.get('cache_write_tokens'),'questions':len(r['request']['questions'])})
    usage['estimated_usd']=((usage['input_tokens']-usage['cached_tokens']-usage['cache_write_tokens'])*.1+usage['cached_tokens']*.01+usage['cache_write_tokens']*.125)/1e6
    data={'observations':summary,'usage':usage,'artificial_prefix':True,'publication_allowed':False}
    (out/'cache-analysis.json').write_text(json.dumps(data,indent=2)+'\n');print(json.dumps(data,indent=2))

if __name__=='__main__':main()
