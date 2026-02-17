/**
 * Set emergency_off in bot_config. Run: npx tsx src/scripts/set-emergency-off.ts [on|off]
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const off = process.argv[2] !== 'on';
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Missing SUPABASE_URL and SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

const supabase = createClient(url, key);
const { error } = await supabase
  .from('bot_config')
  .update({ emergency_off: off })
  .eq('id', 'default');

if (error) {
  console.error(error);
  process.exit(1);
}
console.log(off ? 'Emergency OFF. Bots paused.' : 'Emergency ON. Bots running.');
