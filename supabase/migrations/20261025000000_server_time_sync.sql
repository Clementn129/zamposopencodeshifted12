CREATE OR REPLACE FUNCTION get_server_time()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Return current time in milliseconds from the server
  RETURN (extract(epoch from now()) * 1000)::bigint;
END;
$$;
