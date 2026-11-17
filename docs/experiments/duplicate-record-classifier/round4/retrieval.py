"""Read-only Postgres full-text fact-mention candidate prototype."""
import json
import subprocess
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'round2'))
from engine import name_identity


def source_pool(cases):
    records=[];facts=[]
    for case in cases:
        workspace=case.get('workspace','synthetic')
        for r in case['records']:
            records.append({'id':r['id'],'workspace':workspace,'object':case['kind'],'live':True,'name':r['name'],'query_name':name_identity(r['name'])})
        for i,f in enumerate(case['facts']):
            facts.append({'id':case['id']+'-fact-'+str(i),'owner':case['fact_owner'],'workspace':workspace,'content':f['text'],'ref':f['ref'],'source_live':True,'current':True,'visible':True})
    return records,facts


def fact_mentions(records,facts,db='retainer',per_owner=3,cap=200):
    if not 1<=per_owner<=20 or not 1<=cap<=500:raise ValueError('invalid candidate budget')
    payload=json.dumps({'records':records,'facts':facts},ensure_ascii=False)
    if '$spike$' in payload:raise ValueError('invalid SQL fixture delimiter')
    query='''BEGIN READ ONLY;
WITH data AS (SELECT $spike$PAYLOAD$spike$::jsonb d),
records AS (SELECT r FROM data,jsonb_array_elements(d->'records') r),
facts AS (SELECT f FROM data,jsonb_array_elements(d->'facts') f),
hits AS (
 SELECT owner.r->>'id' owner,other.r->>'id' candidate,
 ts_rank_cd(to_tsvector('simple',f->>'content'),phraseto_tsquery('simple',other.r->>'query_name')) score,
 f->>'ref' source_ref,f->>'id' fact_id
 FROM facts
 JOIN records owner ON owner.r->>'id'=f->>'owner' AND owner.r->>'workspace'=f->>'workspace'
 JOIN records other ON other.r->>'workspace'=owner.r->>'workspace' AND other.r->>'object'=owner.r->>'object'
 AND other.r->>'id'<>owner.r->>'id'
 WHERE (owner.r->>'live')::boolean AND (other.r->>'live')::boolean
 AND owner.r->>'object' IN ('company','person')
 AND (f->>'source_live')::boolean AND (f->>'current')::boolean AND (f->>'visible')::boolean
 AND length(trim(other.r->>'query_name'))>=3
 AND to_tsvector('simple',f->>'content') @@ phraseto_tsquery('simple',other.r->>'query_name')
), per_candidate AS (
 SELECT owner,candidate,max(score) score,jsonb_agg(jsonb_build_object('source_ref',source_ref,'fact_id',fact_id) ORDER BY fact_id) refs FROM hits GROUP BY owner,candidate
), ranked AS (
 SELECT *,row_number() OVER (PARTITION BY owner ORDER BY score DESC,candidate) rank FROM per_candidate
), pairs AS (
 SELECT least(owner,candidate) a,greatest(owner,candidate) b,max(score) score,
 jsonb_agg(jsonb_build_object('owner',owner,'references',refs)) triggers FROM ranked
 WHERE rank<=PER_OWNER GROUP BY least(owner,candidate),greatest(owner,candidate)
)
SELECT jsonb_build_object('candidates',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY a,b) FROM (SELECT * FROM pairs ORDER BY a,b LIMIT GLOBAL_CAP) x),'[]'::jsonb),
 'total_pairs_before_global_cap',(SELECT count(*) FROM pairs),'owner_candidates_before_cap',(SELECT count(*) FROM ranked),
 'owner_candidates_deferred',(SELECT count(*) FROM ranked WHERE rank>PER_OWNER),'globally_deferred',greatest(0,(SELECT count(*) FROM pairs)-GLOBAL_CAP));
ROLLBACK;'''.replace('PAYLOAD',payload).replace('PER_OWNER',str(per_owner)).replace('GLOBAL_CAP',str(cap))
    r=subprocess.run(['docker','exec','-i','docker-postgres-1','psql','-U','retainer','-d',db,'-Atq','-v','ON_ERROR_STOP=1'],input=query,text=True,capture_output=True)
    if r.returncode:raise RuntimeError('Postgres fact-retrieval query failed')
    return json.loads(r.stdout)
