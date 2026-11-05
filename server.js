// Protrax demo server : serves the demo page and forwards calls to TIGA ( backend-for-frontend ).
// - The browser only talks to this server ( same origin, no CORS problem ).
// - The TIGA session cookie is kept HERE, never in the browser, same pattern as the real Protrax backend.
// - Only the paths in CONFIG.AllowedTigaPaths can be forwarded.
// Run : node server.js   then open http://localhost:7500

const http = require( 'http' );
const fs = require( 'fs' );
const path = require( 'path' );

const CONFIG = {
  Host : process.env.DEMO_HOST || '127.0.0.1', // localhost only : this server holds a logged-in TIGA session
  Port : parseInt( process.env.DEMO_PORT || '7500', 10 ),
  TigaBaseUrl : process.env.TIGA_URL || 'http://localhost:5000',
  LoginPath : '/SecurityManager/GetAuthorization',
  UserTimeZone : '+0700',
  // WCF only accepts the exact value "True" ( FugarMessageAPIVersionInspector compares with == "True" )
  IgnoreVersionHeader : { Name : 'Ignore-Version', Value : 'True' },
  ApiVersionCookieName : 'APIVersion',
  TigaCookieName : 'Tiga',
  // GetAuthorization CredentialMap keys
  CredentialMapApiVersionKey : 'APIVersion',
  CredentialMapErrorKey : 'ErrorMessage',
  // MVC ExternalAPI ignores Ignore-Version and needs the APIVersion cookie : read the required version from the mismatch error
  VersionProbe : {
    Path : '/EntityManager/ExternalAPI/VersionProbe',
    Version : '0.0',
    // digits separated by dots only : the message ends with "Require 11.10.89.0. Found 0.0." and the sentence dot must not be captured
    RequireRegex : /Require\s+(\d+(?:\.\d+)*)/
  },
  AllowedTigaPaths : [
    /^\/EntityManager\/RetrieveExtendedBusinessEntity$/,
    /^\/EntityManager\/ExternalAPI\/[A-Za-z]+$/
  ],
  PageFile : path.join( __dirname, 'index.html' ),
  MaxBodyBytes : 5 * 1024 * 1024
};

// in-memory session : one demo, one TIGA user
let _session = {
  Cookies : {},
  Username : null,
  ApiVersion : null
};

function ResetSession()
{
  _session = { Cookies : {}, Username : null, ApiVersion : null };
}

function BuildCookieHeader()
{
  let cookies = Object.assign( {}, _session.Cookies );

  if( _session.ApiVersion )
  {
    cookies[ CONFIG.ApiVersionCookieName ] = _session.ApiVersion;
  }

  return Object.keys( cookies ).map( function ( name ) { return name + '=' + cookies[ name ]; } ).join( '; ' );
}

function StoreSetCookies( setCookieHeaders )
{
  if( !setCookieHeaders )
  {
    return;
  }

  for( let i = 0; i < setCookieHeaders.length; i++ )
  {
    const pair = setCookieHeaders[i].split( ';' )[0];
    const separatorIndex = pair.indexOf( '=' );

    if( separatorIndex > 0 )
    {
      _session.Cookies[ pair.substring( 0, separatorIndex ).trim() ] = pair.substring( separatorIndex + 1 ).trim();
    }
  }
}

function CallTiga( tigaPath, bodyText, query )
{
  return new Promise( function ( resolve, reject )
  {
    const url = new URL( CONFIG.TigaBaseUrl + tigaPath );

    if( query )
    {
      url.search = query;
    }

    let headers = {
      'Content-Type' : 'application/json',
      'Content-Length' : Buffer.byteLength( bodyText || '' )
    };
    headers[ CONFIG.IgnoreVersionHeader.Name ] = CONFIG.IgnoreVersionHeader.Value;

    const cookieHeader = BuildCookieHeader();
    if( cookieHeader )
    {
      headers[ 'Cookie' ] = cookieHeader;
    }

    const start = Date.now();
    const request = http.request( url, { method : 'POST', headers : headers }, function ( response )
    {
      let chunks = [];
      response.on( 'data', function ( chunk ) { chunks.push( chunk ); } );
      response.on( 'end', function ()
      {
        StoreSetCookies( response.headers[ 'set-cookie' ] );
        resolve( {
          Status : response.statusCode,
          Body : Buffer.concat( chunks ).toString( 'utf8' ),
          ElapsedMs : Date.now() - start,
          Url : url.toString()
        } );
      } );
    } );

    request.on( 'error', reject );
    request.write( bodyText || '' );
    request.end();
  } );
}

async function DetectApiVersion()
{
  const savedVersion = _session.ApiVersion;
  _session.ApiVersion = CONFIG.VersionProbe.Version;

  try
  {
    const result = await CallTiga( CONFIG.VersionProbe.Path, '{}' );
    const match = CONFIG.VersionProbe.RequireRegex.exec( result.Body );
    _session.ApiVersion = match ? match[1] : savedVersion;
  }
  catch( error )
  {
    _session.ApiVersion = savedVersion;
  }
}

function ReadBody( request )
{
  return new Promise( function ( resolve, reject )
  {
    let size = 0;
    let chunks = [];

    request.on( 'data', function ( chunk )
    {
      size += chunk.length;

      if( size > CONFIG.MaxBodyBytes )
      {
        reject( new Error( 'Request body is too large' ) );
        request.destroy();
        return;
      }

      chunks.push( chunk );
    } );
    request.on( 'end', function () { resolve( Buffer.concat( chunks ).toString( 'utf8' ) ); } );
    request.on( 'error', reject );
  } );
}

function SendJson( response, status, payload )
{
  response.writeHead( status, { 'Content-Type' : 'application/json; charset=utf-8' } );
  response.end( JSON.stringify( payload ) );
}

function GetSessionInfo()
{
  return {
    IsLoggedIn : !!_session.Cookies[ CONFIG.TigaCookieName ],
    Username : _session.Username,
    ApiVersion : _session.ApiVersion,
    TigaBaseUrl : CONFIG.TigaBaseUrl
  };
}

async function HandleLogin( request, response )
{
  const input = JSON.parse( await ReadBody( request ) || '{}' );

  ResetSession();

  const loginBody = JSON.stringify( {
    userTimeZone : CONFIG.UserTimeZone,
    user : { Username : input.Username, Password : input.Password },
    signedInWithGoogle : false
  } );

  const result = await CallTiga( CONFIG.LoginPath, loginBody );
  const isLoggedIn = result.Status === 200 && !!_session.Cookies[ CONFIG.TigaCookieName ];

  if( isLoggedIn )
  {
    _session.Username = input.Username;
    // newer TIGA returns the version in CredentialMap, older TIGA does not : then fall back to the probe
    _session.ApiVersion = GetCredentialMapValue( result.Body, CONFIG.CredentialMapApiVersionKey );

    if( !_session.ApiVersion )
    {
      await DetectApiVersion();
    }
  }
  else
  {
    ResetSession();
  }

  // TIGA answers a failed login with HTTP 200 + CredentialMap.ErrorMessage, so the session cookie is the real success signal
  // the login response is not sent back when it succeeds : it contains session data
  SendJson( response, isLoggedIn ? 200 : 401, {
    Session : GetSessionInfo(),
    Reason : isLoggedIn ? null : GetLoginErrorMessage( result.Body ),
    Tiga : { Url : result.Url, Status : result.Status, ElapsedMs : result.ElapsedMs, Body : isLoggedIn ? '( hidden )' : result.Body }
  } );
}

function GetCredentialMapValue( bodyText, key )
{
  try
  {
    const body = JSON.parse( bodyText );
    const result = body.GetAuthorizationResult || body;
    const credentialMap = ( result && result.CredentialMap ) || [];
    const pair = credentialMap.find( function ( item ) { return item.Key === key; } );

    return pair ? pair.Value : null;
  }
  catch( error )
  {
    return null; // not JSON
  }
}

function GetLoginErrorMessage( bodyText )
{
  const errorMessage = GetCredentialMapValue( bodyText, CONFIG.CredentialMapErrorKey );

  if( errorMessage )
  {
    return errorMessage;
  }

  try
  {
    const body = JSON.parse( bodyText );

    if( body.Reason )
    {
      return body.Reason;
    }
  }
  catch( error )
  {
    // not JSON, fall through
  }

  return 'TIGA did not return a session ( wrong credential, or the account needs OTP / Google login ).';
}

async function HandleTigaForward( request, response, requestUrl, tigaPath )
{
  const isAllowed = CONFIG.AllowedTigaPaths.some( function ( pattern ) { return pattern.test( tigaPath ); } );

  if( !isAllowed )
  {
    SendJson( response, 403, { Reason : 'Path ' + tigaPath + ' is not allowed by the demo server.' } );
    return;
  }

  if( !_session.Cookies[ CONFIG.TigaCookieName ] )
  {
    SendJson( response, 401, { Reason : 'Not logged in to TIGA yet.' } );
    return;
  }

  const result = await CallTiga( tigaPath, await ReadBody( request ), requestUrl.search );

  SendJson( response, 200, { Url : result.Url, Status : result.Status, ElapsedMs : result.ElapsedMs, Body : result.Body } );
}

const server = http.createServer( async function ( request, response )
{
  const requestUrl = new URL( request.url, 'http://' + ( request.headers.host || 'localhost' ) );

  try
  {
    if( request.method === 'GET' && ( requestUrl.pathname === '/' || requestUrl.pathname === '/index.html' ) )
    {
      response.writeHead( 200, { 'Content-Type' : 'text/html; charset=utf-8', 'Cache-Control' : 'no-store' } );
      fs.createReadStream( CONFIG.PageFile ).pipe( response );
    }
    else if( request.method === 'GET' && requestUrl.pathname === '/api/session' )
    {
      SendJson( response, 200, GetSessionInfo() );
    }
    else if( request.method === 'POST' && requestUrl.pathname === '/api/login' )
    {
      await HandleLogin( request, response );
    }
    else if( request.method === 'POST' && requestUrl.pathname === '/api/logout' )
    {
      ResetSession();
      SendJson( response, 200, GetSessionInfo() );
    }
    else if( request.method === 'POST' && requestUrl.pathname.indexOf( '/tiga/' ) === 0 )
    {
      await HandleTigaForward( request, response, requestUrl, requestUrl.pathname.substring( '/tiga'.length ) );
    }
    else if( request.method === 'POST' && requestUrl.pathname.indexOf( '/EntityManager/ExternalAPI/' ) === 0 )
    {
      // same path as TIGA : http://localhost:7500/EntityManager/ExternalAPI/<Action> -> http://localhost:5000/EntityManager/ExternalAPI/<Action>
      await HandleTigaForward( request, response, requestUrl, requestUrl.pathname );
    }
    else
    {
      SendJson( response, 404, { Reason : 'Not found' } );
    }
  }
  catch( error )
  {
    SendJson( response, 502, { Reason : 'Demo server cannot reach TIGA at ' + CONFIG.TigaBaseUrl + ' : ' + error.message } );
  }
} );

server.on( 'error', function ( error )
{
  if( error.code === 'EADDRINUSE' )
  {
    console.error( 'Port ' + CONFIG.Port + ' is already used ( the demo server is probably already running ).' );
    console.error( 'Open http://localhost:' + CONFIG.Port + ' , or stop the other process, or run with another port : set DEMO_PORT=7501 && node server.js' );
    process.exit( 1 );
  }

  throw error;
} );

server.listen( CONFIG.Port, CONFIG.Host, function ()
{
  console.log( 'Protrax demo  : http://localhost:' + CONFIG.Port );
  console.log( 'Forwarding to : ' + CONFIG.TigaBaseUrl );
} );
