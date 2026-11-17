import copy
from concurrent.futures import ThreadPoolExecutor
import json
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import time
import unittest
import urllib.request
sys.path.insert(0,str(Path(__file__).resolve().parent))
from runtime import Budget,InvalidDecision,transport,validate
from matrix import bounded_request,digest,plan,regressions,stress_case,assessment

REQUEST={'model':'gpt-6-luna','input':'Synthetic pair.','questions':[{'name':'identity','type':'choice','instructions':'same or different','choices':[{'value':'same_entity'},{'value':'different_entities'}]}]}


def valid():return {'model':'gpt-6-luna','answers':[{'name':'identity','type':'choice','choice':'same_entity','probabilities':[{'value':'same_entity','probability':.99},{'value':'different_entities','probability':.01}],'confidence':.99}],'usage':{'input_tokens':100,'output_tokens':0,'total_tokens':100,'input_tokens_details':{'cached_tokens':0,'cache_write_tokens':0}}}


class ValidationTests(unittest.TestCase):
    def reject(self,body):
        with self.assertRaises(InvalidDecision):validate(body,REQUEST)
    def test_valid_choice(self):self.assertEqual(validate(valid(),REQUEST)['identity']['choice'],'same_entity')
    def test_scalar_container_rejected(self):
        for b in [None,[],1,True,'answers']:self.reject(b)
    def test_scalar_answer_rejected(self):
        for a in [None,[],1,True,'answer']:
            b=valid();b['answers'][0]=a;self.reject(b)
    def test_wrong_model(self):
        b=valid();b['model']='other-model';self.reject(b)
    def test_missing_model(self):
        b=valid();b.pop('model');self.reject(b)
    def test_boolean_probability(self):
        b=valid();b['answers'][0]['probabilities'][0]['probability']=True;self.reject(b)
    def test_nonfinite_probability(self):
        for p in [float('nan'),float('inf'),-float('inf')]:
            b=valid();b['answers'][0]['probabilities'][0]['probability']=p;self.reject(b)
    def test_duplicate_probability_options(self):
        b=valid();b['answers'][0]['probabilities'][1]['value']='same_entity';self.reject(b)
    def test_invalid_distribution_shape(self):
        for value in [None,[None],{},'bad']:
            b=valid();b['answers'][0]['probabilities']=value;self.reject(b)
    def test_invalid_sum(self):
        b=valid();b['answers'][0]['probabilities'][0]['probability']=.5;self.reject(b)
    def test_wrong_question_name(self):
        b=valid();b['answers'][0]['name']='other';self.reject(b)
    def test_refusal(self):
        b=valid();b['answers'][0]={'type':'refusal','name':'identity'};self.reject(b)
    def test_negative_or_boolean_usage(self):
        for value in [-1,True,'100']:
            b=valid();b['usage']['input_tokens']=value;self.reject(b)
    def test_cache_tokens_not_double_counted(self):
        b=valid();b['usage']['input_tokens_details']={'cached_tokens':60,'cache_write_tokens':50};self.reject(b)
    def test_usage_total_consistent(self):
        b=valid();b['usage']['total_tokens']=101;self.reject(b)
    def test_predicate_boolean_rejected(self):
        req={**REQUEST,'questions':[{'type':'predicate','name':'p'}]};b={'model':'gpt-6-luna','answers':[{'type':'predicate','name':'p','probability':True}]}
        with self.assertRaises(InvalidDecision):validate(b,req)


class HTTPBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.responses=[];self.requests=[];outer=self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length=int(self.headers['Content-Length']);body=json.loads(self.rfile.read(length));outer.requests.append({'path':self.path,'authorization':self.headers.get('Authorization'),'body':body})
                spec=outer.responses.pop(0);delay=spec.get('delay',0)
                if delay:time.sleep(delay)
                self.send_response(spec.get('status',200))
                for k,v in spec.get('headers',{}).items():self.send_header(k,v)
                self.end_headers();payload=spec.get('body',valid());data=payload if isinstance(payload,bytes) else json.dumps(payload).encode()
                try:self.wfile.write(data)
                except (BrokenPipeError,ConnectionResetError):pass
            def log_message(self,*args):pass
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.sleeps=[]
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join()
    def opener(self,req,timeout):
        local=urllib.request.Request(f'http://127.0.0.1:{self.server.server_port}/v1/decisions',data=req.data,headers=dict(req.header_items()))
        return urllib.request.urlopen(local,timeout=timeout)
    def run_call(self,**kwargs):return transport(REQUEST,'synthetic-test-key',Budget(4,1),opener=self.opener,sleep=self.sleeps.append,**kwargs)
    def test_actual_http_success_and_shape(self):
        self.responses=[{}];r=self.run_call();self.assertTrue(r['ok']);self.assertEqual(self.requests[0]['body'],REQUEST);self.assertEqual(self.requests[0]['path'],'/v1/decisions');self.assertEqual(self.requests[0]['authorization'],'Bearer synthetic-test-key')
    def test_rate_limit_honors_bounded_retry_after(self):
        self.responses=[{'status':429,'headers':{'Retry-After':'2'}},{}];r=self.run_call();self.assertTrue(r['ok']);self.assertEqual(len(r['attempts']),2);self.assertEqual(self.sleeps,[2])
    def test_long_retry_after_defers_without_retrying_early(self):
        self.responses=[{'status':429,'headers':{'Retry-After':'60'}}];r=self.run_call()
        self.assertFalse(r['ok']);self.assertEqual(len(r['attempts']),1);self.assertTrue(r['attempts'][0]['deferred_retry_after']);self.assertEqual(self.sleeps,[])
    def test_http_date_retry_after_defers_without_retrying_early(self):
        self.responses=[{'status':429,'headers':{'Retry-After':'Thu, 01 Jan 2099 00:00:00 GMT'}}];r=self.run_call()
        self.assertFalse(r['ok']);self.assertEqual(len(r['attempts']),1);self.assertTrue(r['attempts'][0]['deferred_retry_after'])
    def test_transient_errors_retry_once(self):
        for status in [500,502,503]:
            self.responses=[{'status':status},{}];r=self.run_call();self.assertTrue(r['ok']);self.assertEqual(len(r['attempts']),2)
    def test_repeated_server_error_defers(self):
        self.responses=[{'status':503},{'status':503}];r=self.run_call();self.assertFalse(r['ok']);self.assertEqual(len(r['attempts']),2)
    def test_unauthorized_not_retried(self):
        self.responses=[{'status':401}];r=self.run_call();self.assertFalse(r['ok']);self.assertEqual(len(r['attempts']),1)
    def test_invalid_input_not_retried(self):
        self.responses=[{'status':400}];r=self.run_call();self.assertFalse(r['ok']);self.assertEqual(len(r['attempts']),1)
    def test_bad_json_defers_with_uncertain_charge(self):
        self.responses=[{'body':b'not-json'}];r=self.run_call();self.assertFalse(r['ok']);self.assertEqual(r['attempts'][0]['error'],'invalid_json');self.assertTrue(r['attempts'][0]['uncertain_charge'])
    def test_scalar_response_defers_without_crash(self):
        self.responses=[{'body':[]}];r=self.run_call();self.assertFalse(r['ok']);self.assertEqual(r['attempts'][0]['error'],'response_object')
    def test_refusal_retains_billed_usage(self):
        b=valid();b['answers'][0]={'name':'identity','type':'refusal'};self.responses=[{'body':b}];r=self.run_call();self.assertFalse(r['ok']);self.assertEqual(r['attempts'][0]['body']['usage']['input_tokens'],100);self.assertEqual(len(r['attempts']),1)
    def test_wrong_model_defers_and_preserves_usage(self):
        b=valid();b['model']='other-model';self.responses=[{'body':b}];r=self.run_call();self.assertFalse(r['ok']);self.assertEqual(r['attempts'][0]['error'],'model_mismatch');self.assertIn('usage',r['attempts'][0]['body'])
    def test_timeout_is_not_different_entities(self):
        self.responses=[{'delay':.15},{'delay':.15}];r=self.run_call(timeout=.02);self.assertFalse(r['ok']);self.assertEqual(len(r['attempts']),2);self.assertTrue(all(a['uncertain_charge'] for a in r['attempts']))
    def test_unexpected_success_status_defers(self):
        self.responses=[{'status':202}];r=self.run_call();self.assertFalse(r['ok']);self.assertEqual(r['attempts'][0]['error'],'unexpected_success_status')


class BudgetAndMatrixTests(unittest.TestCase):
    def test_concurrent_attempt_budget(self):
        b=Budget(3,1);barrier=threading.Barrier(10)
        def reserve(_):barrier.wait();return b.reserve(REQUEST)
        with ThreadPoolExecutor(max_workers=10) as workers:results=list(workers.map(reserve,range(10)))
        self.assertEqual(sum(results),3);self.assertEqual(b.attempts,3)
    def test_spend_reservation_blocks_without_dispatch(self):
        b=Budget(10,0);r=transport(REQUEST,'synthetic',b,opener=lambda *_:self.fail('must not dispatch'));self.assertFalse(r['ok']);self.assertEqual(r['attempts'],[])
    def test_deadline_blocks_without_dispatch(self):
        b=Budget(10,1);b.deadline=time.monotonic()-1;self.assertFalse(b.reserve(REQUEST))
    def test_tight_context_does_not_leak_omitted_fact_in_questions(self):
        c=stress_case(6,False);r=bounded_request(c,1200);data=json.loads(r['input'])
        self.assertEqual(data['omitted']['facts'],1);self.assertEqual(len(data['facts']),1);self.assertNotIn('registrar correction',json.dumps(r))
    def test_full_context_preserves_counterevidence(self):
        r=bounded_request(stress_case(6,False),8192);self.assertIn('registrar correction',json.dumps(r));self.assertEqual(json.loads(r['input'])['omitted']['facts'],0)
    def test_omission_guard_defers_positive_looking_answer(self):
        c=stress_case(6,False);req=bounded_request(c,1200);answers=[]
        for q in req['questions']:
            if q['type']=='predicate':answers.append({'type':'predicate','name':q['name'],'probability':0.0})
            else:
                choice='same_entity' if q['name']=='identity' else 'source_1';answers.append({'type':'choice','name':q['name'],'choice':choice,'confidence':1.0,'probabilities':[{'value':x['value'],'probability':1.0 if x['value']==choice else 0.0} for x in q['choices']]})
        b={'model':'gpt-6-luna','answers':answers}
        self.assertTrue(assessment(b,req,False)['publish']);self.assertFalse(assessment(b,req)['publish']);self.assertFalse(assessment(b,req,True)['publish'])
    def test_frozen_matrix_hash_and_size(self):
        jobs=plan();protocol=json.loads((Path(__file__).with_name('results')/'protocol.json').read_text());self.assertEqual(digest(jobs),protocol['matrix_sha256']);self.assertEqual(len(jobs),352)
    def test_no_synthetic_gold_fields_in_new_stress_prompts(self):
        for j in plan():
            for field in ['gold_support','duplicate','reference_body']:
                self.assertNotIn('"'+field+'"',json.dumps(j['request']))

class CanonicalizationTests(unittest.TestCase):
    def test_reversal_converges_without_choosing_an_answer(self):
        from safety import canonical_request
        from matrix import reverse_request
        for job in regressions():
            expected=canonical_request(job['request'])
            for mode in ['record_reverse','evidence_reverse','question_reverse']:
                self.assertEqual(canonical_request(reverse_request(job['request'],mode)),expected)
    def test_same_record_copies_are_not_real_pairs(self):
        from safety import canonical_request
        req=copy.deepcopy(regressions()[0]['request']);context=json.loads(req['input']);context['records'][1]['id']=context['records'][0]['id'];req['input']=json.dumps(context)
        with self.assertRaisesRegex(ValueError,'distinct_record_ids_required'):canonical_request(req)
    def test_duplicate_evidence_reference_rejected(self):
        from safety import canonical_request
        req=bounded_request(stress_case(6,False),8192);context=json.loads(req['input']);context['facts'][1]['ref']=context['facts'][0]['ref'];req['input']=json.dumps(context)
        with self.assertRaisesRegex(ValueError,'ambiguous_evidence_references'):canonical_request(req)
    def test_injection_changes_input_digest(self):
        from safety import canonical_request
        from matrix import reverse_request
        req=regressions()[0]['request'];self.assertNotEqual(canonical_request(req),canonical_request(reverse_request(req,'injection')))
    def test_unknown_or_missing_omission_state_is_not_complete(self):
        from safety import complete_context
        for marker in [None,[],{'facts':True},{'facts':-1},{'facts':1}]:
            self.assertFalse(complete_context({'input':json.dumps({'omitted':marker})}))
        self.assertTrue(complete_context({'input':json.dumps({'omitted':{'facts':0,'history':0}})}))

if __name__=='__main__':unittest.main()
