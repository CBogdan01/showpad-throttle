// Kept static: policy values and keys are arguments, never interpolated into Lua.
const VALIDATE = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local period = tonumber(ARGV[2])
local function integer(value, minimum, maximum)
  return value and value == math.floor(value) and value >= minimum and value <= maximum
end
if not integer(limit, 1, 10000) or not integer(period, 1000, 86400000)
    or not integer(now, 0, 9007199168340991) then
  return redis.error_reply('Invalid rate limit arguments')
end
`;

export const FIXED_WINDOW_BODY = VALIDATE + `
local count = 0
local resetAt = now + period
if redis.call('EXISTS', key) == 1 then
  local state = redis.call('HMGET', key, 'count', 'resetAtMs')
  count = tonumber(state[1])
  resetAt = tonumber(state[2])
  if not integer(count, 1, limit) or not integer(resetAt, 0, 9007199254740991) then
    return redis.error_reply('Invalid fixed window state')
  end
  if now >= resetAt then
    count = 0
    resetAt = now + period
  end
end
if count >= limit then
  return {0, resetAt - now}
end
redis.call('HSET', key, 'count', count + 1, 'resetAtMs', resetAt)
redis.call('PEXPIRE', key, math.max(1, resetAt - now))
return {1, 0}
`;

export const TOKEN_BUCKET_BODY = VALIDATE + `
local capacity = limit * period
local credits = capacity
local last = now
if redis.call('EXISTS', key) == 1 then
  local state = redis.call('HMGET', key, 'credits', 'lastRefillMs')
  credits = tonumber(state[1])
  local previous = tonumber(state[2])
  if not integer(credits, 0, capacity) or not integer(previous, 0, 9007199168340991) then
    return redis.error_reply('Invalid token bucket state')
  end
  last = math.max(now, previous)
  local elapsed = math.min(period, last - previous)
  credits = math.min(capacity, credits + elapsed * limit)
end
local debt = last - now
local allowed = 0
local retry = 0
if credits >= period then
  credits = credits - period
  allowed = 1
else
  retry = debt + math.ceil((period - credits) / limit)
end
redis.call('HSET', key, 'credits', credits, 'lastRefillMs', last)
redis.call('PEXPIRE', key, period + debt)
return {allowed, retry}
`;

const REDIS_TIME = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
`;

export const REDIS_SCRIPTS = Object.freeze({
  'fixed-window': REDIS_TIME + FIXED_WINDOW_BODY,
  'token-bucket': REDIS_TIME + TOKEN_BUCKET_BODY,
});
