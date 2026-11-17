import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent))
from experiment import CANDIDATES,assess,digest,metric,request_for
from cases import development,heldout


def response(req,same=.84,evidence=.99,support=.99,distinct=.01,ref='source_1',label='same_entity'):
    answers=[]
    for q in req['questions']:
        if q['type']=='predicate':
            answers.append({'name':q['name'],'type':'predicate','probability':support if q['name']=='supported_identity_link' else distinct})
        else:
            value=label if q['name']=='identity' else ref;p=same if q['name']=='identity' else evidence
            answers.append({'name':q['name'],'type':'choice','choice':value,'confidence':.99,'probabilities':[{'value':c['value'],'probability':p if c['value']==value else (1-p)/(len(q['choices'])-1)} for c in q['choices']]})
    return {'model':'gpt-6-luna','answers':answers}


class EvidencePolicyTests(unittest.TestCase):
    def setUp(self):self.case=development()[0];self.request=request_for(self.case);self.policy=CANDIDATES[0]
    def test_well_supported_below_090_is_eligible(self):
        body=response(self.request,same=.84)
        self.assertTrue(assess(body,self.request,self.policy)['publish'])
        self.assertFalse(assess(body,self.request,{'name':'baseline_090'})['publish'])
    def test_label_without_selected_source_not_eligible(self):
        self.assertFalse(assess(response(self.request,ref='none'),self.request,self.policy)['publish'])
    def test_reference_probability_is_required(self):
        self.assertFalse(assess(response(self.request,evidence=.7),self.request,self.policy)['publish'])
    def test_independent_support_is_required(self):
        self.assertFalse(assess(response(self.request,support=.2),self.request,self.policy)['publish'])
    def test_identity_floor_still_required(self):
        self.assertFalse(assess(response(self.request,same=.69),self.request,self.policy)['publish'])
    def test_affirmative_separation_vetoes_identity_claim(self):
        self.assertFalse(assess(response(self.request,distinct=.8),self.request,self.policy)['publish'])
    def test_different_label_vetoes_good_evidence_answers(self):
        self.assertFalse(assess(response(self.request,label='different_entities'),self.request,self.policy)['publish'])
    def test_profile_conflicts_remain_unresolved(self):
        case=copy.deepcopy(self.case);case['records'][0]['linkedin']='https://linkedin.com/company/a';case['records'][1]['linkedin']='https://linkedin.com/company/b'
        req=request_for(case);self.assertFalse(assess(response(req),req,self.policy)['publish'])
    def test_omitted_counterevidence_defers(self):
        req=copy.deepcopy(self.request);context=json.loads(req['input']);context['omitted']['facts']=1;req['input']=json.dumps(context)
        self.assertFalse(assess(response(req),req,self.policy)['publish'])
    def test_exact_route_still_requires_090_identity_and_support(self):
        case=copy.deepcopy(self.case)
        for r in case['records']:r.update(website='https://verified.example',linkedin='https://linkedin.com/company/verified')
        req=request_for(case)
        self.assertFalse(assess(response(req,same=.84,ref='none'),req,self.policy)['publish'])
        self.assertTrue(assess(response(req,same=.96,ref='none'),req,self.policy)['publish'])
    def test_invalid_reference_cannot_be_published(self):
        with self.assertRaises(ValueError):assess(response(self.request,ref='made_up'),self.request,self.policy)
    def test_refusal_remains_error(self):
        body=response(self.request);body['answers'][-1]={'name':'supported_identity_link','type':'refusal'}
        with self.assertRaisesRegex(ValueError,'refusal'):assess(body,self.request,self.policy)
    def test_wrong_rationale_fails_even_for_correct_identity(self):
        case=copy.deepcopy(self.case);case['facts'].append({'ref':'wrong','text':'The two companies share an investor.'});req=request_for(case)
        raw={'id':case['id'],'variant':'forward','request':req,'result':{'ok':True,'attempts':[{'body':response(req,ref='wrong')} ]}}
        candidates={'candidates':[{'a':case['records'][0]['id'],'b':case['records'][1]['id']}]}
        stats=metric([case],[raw],self.policy,candidates)
        self.assertEqual(stats['tp'],1);self.assertEqual(stats['unsupported_explanations'],1)
    def test_failed_calls_remain_in_recall_denominator(self):
        stats=metric([self.case],[{'id':self.case['id'],'result':{'ok':False,'attempts':[]}}],self.policy,{'candidates':[]})
        self.assertEqual(stats['api_failures'],1);self.assertEqual(stats['publication_recall'],0)
    def test_corpus_is_split_by_story_and_requests_do_not_leak_labels(self):
        dev=development();test=heldout();self.assertFalse({r['id'] for r in dev}&{r['id'] for r in test})
        self.assertEqual((len(dev),len(test)),(24,48))
        for row in dev+test:
            request=json.dumps(request_for(row))
            self.assertNotIn(row['id'],request)
            for field in ['duplicate','gold_support','split']:self.assertNotIn('"'+field+'"',request)
    def test_audit_includes_additional_identifiers_without_labels(self):
        from audit_people import candidate_pool
        records,additional=candidate_pool({'records':[{'id':'one','label':'unused','fields':{'name':{'first':'Ada','last':'Levin'},'emails':{'primary':'ada@one.example','additional':['ada@two.example']},'phones':{'primary':{'number':'+12025550111'},'additional':[{'number':'+12025550112'}]}}}]})
        self.assertEqual(additional,2);self.assertEqual(records[0]['record']['name'],'Ada Levin')
        self.assertEqual({h['value'] for h in records[0]['history']},{'ada@two.example','+12025550112'})
        self.assertNotIn('duplicate',records[0]);self.assertNotIn('label',records[0])
    def test_primary_email_is_not_overwritten_by_aliases(self):
        from audit_people import candidate_pool
        rows,_=candidate_pool({'records':[{'id':'one','label':'A','fields':{'name':{'first':'A'},'emails':{'primary':'first@example.org','additional':['second@example.org']}}}]})
        self.assertEqual(rows[0]['record']['email'],'first@example.org')
    def test_frozen_hashes_match_inputs(self):
        p=Path(__file__).with_name('results')/'protocol.json';protocol=json.loads(p.read_text())
        for name,rows in [('development',development()),('heldout',heldout())]:
            self.assertEqual(protocol['datasets'][name],digest(rows));self.assertEqual(protocol['requests'][name],digest([request_for(c) for c in rows]))

if __name__=='__main__':unittest.main()
