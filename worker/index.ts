const VOICES = new Set(['ja-JP-NanamiNeural','ja-JP-KeitaNeural','ja-JP-AoiNeural','ja-JP-DaichiNeural','ja-JP-MayuNeural','ja-JP-NaokiNeural','ja-JP-ShioriNeural']);

function cors(origin: string): HeadersInit {
  return {'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Vary':'Origin'};
}

function xml(value: string): string {
  return value.replace(/[<>&"']/g, character => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'})[character] as string);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin') || '';
    if (origin !== env.ALLOWED_ORIGIN) return new Response('Forbidden', {status:403});
    if (request.method === 'OPTIONS') return new Response(null, {status:204,headers:cors(origin)});
    if (request.method !== 'POST') return new Response('Method not allowed', {status:405,headers:cors(origin)});
    let input: {text?:unknown;voice?:unknown;speed?:unknown};
    try { input = await request.json(); }
    catch { return Response.json({error:'invalid_request'},{status:400,headers:cors(origin)}); }
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    const voice = typeof input.voice === 'string' && VOICES.has(input.voice) ? input.voice : 'ja-JP-NanamiNeural';
    const speed = Math.min(1.15, Math.max(.55, Number(input.speed) || .85));
    if (!text || text.length > 80) return Response.json({error:'text_required'},{status:400,headers:cors(origin)});
    const ssml = `<speak version="1.0" xml:lang="ja-JP"><voice name="${voice}"><prosody rate="${Math.round((speed - 1) * 100)}%">${xml(text)}</prosody></voice></speak>`;
    const azure = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method:'POST',
      headers:{'Ocp-Apim-Subscription-Key':env.AZURE_SPEECH_KEY,'Content-Type':'application/ssml+xml','X-Microsoft-OutputFormat':'audio-24khz-48kbitrate-mono-mp3','User-Agent':'talking-album'},
      body:ssml,
    });
    if (!azure.ok) {
      console.error(JSON.stringify({event:'azure_tts_failed',status:azure.status}));
      return Response.json({error:'voice_generation_failed'},{status:502,headers:cors(origin)});
    }
    const headers = new Headers(cors(origin));
    headers.set('Content-Type','audio/mpeg');
    headers.set('Cache-Control','no-store');
    return new Response(azure.body,{status:200,headers});
  },
} satisfies ExportedHandler<Env>;
