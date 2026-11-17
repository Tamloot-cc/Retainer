"""Deterministic spike safeguards; not deployed product behavior."""
import copy
import json

ORDER={'identity':0,'identity_evidence':1,'explicit_distinct':2,'supported_identity_link':3}
IDENTITY_ORDER={'same_entity':0,'different_entities':1,'insufficient_evidence':2}


def canonical_request(original):
    request=copy.deepcopy(original);context=json.loads(request['input'])
    records=context.get('records')
    if not isinstance(records,list) or len(records)!=2 or any(not isinstance(r,dict) or not isinstance(r.get('id'),str) for r in records):raise ValueError('two_id_bearing_records_required')
    if records[0]['id']==records[1]['id']:raise ValueError('distinct_record_ids_required')
    permutation=sorted(range(2),key=lambda i:records[i]['id']);context['records']=[records[i] for i in permutation]
    if 'historical_assertions' in context:
        history=context['historical_assertions']
        if not isinstance(history,list) or len(history)!=2:raise ValueError('history_alignment')
        context['historical_assertions']=[sorted(history[i],key=lambda x:json.dumps(x,sort_keys=True)) for i in permutation]
    if permutation==[1,0] and isinstance(context.get('provenance'),dict) and set(context['provenance'])=={'left','right'}:
        p=context['provenance'];context['provenance']={'left':p['right'],'right':p['left']}
    facts=context.get('facts',[]);refs=[f['ref'] for f in facts]
    if len(refs)!=len(set(refs)) or 'none' in refs:raise ValueError('ambiguous_evidence_references')
    context['facts']=sorted(facts,key=lambda f:f['ref'])
    questions=request['questions'];names=[q['name'] for q in questions]
    if len(names)!=len(set(names)) or any(n not in ORDER for n in names):raise ValueError('unknown_or_duplicate_question')
    for q in questions:
        if q['type']=='choice':
            if q['name']=='identity':q['choices'].sort(key=lambda c:IDENTITY_ORDER[c['value']])
            elif q['name']=='identity_evidence':q['choices'].sort(key=lambda c:(c['value']!='none',c['value']))
    request['questions']=sorted(questions,key=lambda q:ORDER[q['name']]);request['input']=json.dumps(context,sort_keys=True,ensure_ascii=False,separators=(',',':'))
    return request


def complete_context(request):
    context=json.loads(request['input']);omitted=context.get('omitted')
    return isinstance(omitted,dict) and all(type(n) is int and n==0 for n in omitted.values())
