-- 진단용 쿼리 — Supabase SQL Editor에서 실행하고 결과를 확인하세요.
-- 결과에 행이 하나라도 나오면, 그 이메일 계정은 household_members가 없는 상태입니다.

select u.id, u.email, u.created_at, hm.household_id
from auth.users u
left join public.household_members hm on hm.user_id = u.id
where hm.household_id is null
order by u.created_at desc;

-- 참고: handle_new_user() 트리거 함수가 실제로 households를 만드는 최신 버전인지 확인
select prosrc like '%households%' as is_updated_trigger
from pg_proc where proname = 'handle_new_user';
