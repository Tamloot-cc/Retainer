import copy
import io
import json
import unittest
import urllib.error
from spike import fixtures, plan, request_for, publication, transport, validate


def response(request, label='same_entity', evidence='none', distinct=.01):
    answers=[]
    for q in request['questions']:
        if q['type']=='predicate':
            answers.append({'name':q['name'],'type':'predicate','probability':distinct})
        else:
            choice = label if q['name']=='identity' else evidence
            n=len(q['choices'])
            answers.append({'name':q['name'],'type':'choice','choice':choice,'confidence':.97,
                            'probabilities':[{'value':c['value'],'probability':.98 if c['value']==choice else .02/(n-1)} for c in q['choices']]})
    return {'model':'gpt-6-luna','answers':answers}


class FakeResponse(io.BytesIO):
    status=200


class SpikeTests(unittest.TestCase):
    def setUp(self):
        self.rows=fixtures()
        self.request=request_for(self.rows[0])

    def test_fixture_balance_and_presplit(self):
        self.assertEqual(len(self.rows),200)
        self.assertEqual(sum(r['duplicate'] for r in self.rows),50)
        self.assertEqual(sum(r['duplicate'] for r in self.rows if r['split']=='heldout'),15)
        self.assertEqual(len({r['id'] for r in self.rows}),200)
        self.assertEqual(len(plan(self.rows)),720)

    def test_no_labels_or_split_in_model_input(self):
        for row in self.rows:
            data=json.loads(request_for(row)['input'])
            self.assertNotIn('duplicate',data)
            self.assertNotIn('split',data)

    def test_context_ablation_has_no_history_leak(self):
        for variant in ['fields','provenance']:
            req=request_for(self.rows[1],variant)
            self.assertNotIn('legal registry',json.dumps(req))
            self.assertNotIn('identity_evidence', [q['name'] for q in req['questions']])

    def test_exact_identity_template(self):
        result=publication(response(self.request),self.request)
        self.assertTrue(result['publish'])
        self.assertEqual(result['explanation'],'Same full company profile and website.')

    def test_fact_support_template(self):
        req=request_for(self.rows[1])
        result=publication(response(req,evidence='fact_1'),req)
        self.assertTrue(result['publish'])
        self.assertIn('fact_1',result['explanation'])

    def test_no_support_abstains(self):
        req=request_for(self.rows[1],'fields')
        self.assertFalse(publication(response(req),req)['publish'])

    def test_strong_conflict_veto(self):
        req=request_for(self.rows[5])
        self.assertFalse(publication(response(req),req)['publish'])

    def test_contradictory_answers_veto(self):
        self.assertFalse(publication(response(self.request,distinct=.99),self.request)['publish'])

    def test_threshold_uses_probability_not_confidence(self):
        body=response(self.request)
        body['answers'][0]['probabilities']=[{'value':v,'probability':p} for v,p in zip(['same_entity','different_entities','insufficient_evidence'],[.8,.1,.1])]
        self.assertFalse(publication(body,self.request)['publish'])

    def test_invalid_responses(self):
        valid=response(self.request)
        mutations=[lambda b:b['answers'].pop(), lambda b:b['answers'][0].update(name='wrong'),
                   lambda b:b['answers'][0].update(choice='invented'), lambda b:b['answers'][0].update(type='refusal'),
                   lambda b:b['answers'][0]['probabilities'][0].update(probability=2),
                   lambda b:b['answers'][0].update(confidence=float('nan'))]
        for mutate in mutations:
            body=copy.deepcopy(valid);mutate(body)
            with self.assertRaises(ValueError):validate(body,self.request)

    def test_transient_http_failures_retry(self):
        for status in [429,500,503]:
            calls=[]
            def opener(req,timeout):
                calls.append(req)
                if len(calls)==1:raise urllib.error.HTTPError(req.full_url,status,'simulated',{},None)
                return FakeResponse(json.dumps(response(self.request)).encode())
            result=transport(self.request,'synthetic-test-key',opener=opener)
            self.assertTrue(result['ok']);self.assertEqual(len(result['attempts']),2)

    def test_permanent_http_failure_no_retry(self):
        def opener(req,timeout):raise urllib.error.HTTPError(req.full_url,401,'simulated',{},None)
        result=transport(self.request,'synthetic-test-key',opener=opener)
        self.assertFalse(result['ok']);self.assertEqual(len(result['attempts']),1)

    def test_timeout_retry_limit_and_uncertain_charges(self):
        def opener(req,timeout):raise TimeoutError()
        result=transport(self.request,'synthetic-test-key',opener=opener)
        self.assertFalse(result['ok']);self.assertEqual(len(result['attempts']),2)
        self.assertTrue(all(a['uncertain_charge'] for a in result['attempts']))

    def test_invalid_json_no_retry(self):
        result=transport(self.request,'synthetic-test-key',opener=lambda req,timeout:FakeResponse(b'not json'))
        self.assertFalse(result['ok']);self.assertEqual(len(result['attempts']),1)

    def test_refusal_no_retry(self):
        body={'answers':[{'name':q['name'],'type':'refusal'} for q in self.request['questions']]}
        result=transport(self.request,'synthetic-test-key',opener=lambda req,timeout:FakeResponse(json.dumps(body).encode()))
        self.assertFalse(result['ok']);self.assertEqual(result['attempts'][0]['error'],'refusal')


if __name__=='__main__':unittest.main()
