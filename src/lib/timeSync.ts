import { supabase } from '@/integrations/supabase/client';

/**
 * Local offset in milliseconds between the server time and the local system time.
 * ServerTime = LocalTime + offset
 */
let serverTimeOffset = 0;

export const syncServerTime = async (): Promise<number> => {
  try {
    const start = Date.now();
    // We use a simple RPC or any fast endpoint to get the server time.
    // For Supabase, we can call a simple RPC that returns now().
    const { data, error } = await supabase.rpc('get_server_time');
    
    if (error) throw error;

    const end = Date.now();
    const latency = (end - start) / 2;
    
    // serverTime is the timestamp returned by the server
    const serverTime = data; 
    const localTimeAtResponse = end;
    
    // offset = ServerTime - (LocalTime - latency)
    serverTimeOffset = serverTime - (localTimeAtResponse - latency);
    
    console.log(`[TimeSync] Server offset calculated: ${serverTimeOffset}ms`);
    return serverTimeOffset;
  } catch (e) {
    console.error('[TimeSync] Failed to sync server time:', e);
    return serverTimeOffset;
  }
};

export const getServerTime = () => Date.now() + serverTimeOffset;

export const getTimeDrift = () => {
  return Math.abs(serverTimeOffset);
};

export const isTimeDriftSignificant = (thresholdMs = 300_000) => {
  return getTimeDrift() > thresholdMs;
};
