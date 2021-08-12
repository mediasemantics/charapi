var express = require('express');
var bodyParser = require('body-parser');
var fs = require('fs');
var request = require('request');
var AWS = require('aws-sdk');
var zlib = require('zlib');
var lockFile = require('lockfile');


// TODO set up your Character API key here
var charAPIKey = "xxxxxxxx";

var polly = new AWS.Polly({
  region: 'us-east-1',
  maxRetries: 3,
  accessKeyId: 'xxxxxxxxxxxxxxxxxxxx',
  secretAccessKey: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  timeout: 15000
});

// TODO set the path to your cache directory, and make sure to give it read/write permission, e.g. mkdir cache && sudo chgrp apache cache && sudo chmod g+w cache
var cachePrefix = "./cache/";

// Set up express
var app = express();
app.use(bodyParser.json({limit: '1mb'}));
app.use(bodyParser.urlencoded({ limit: '1mb', extended: true }));

// The Character API endpoint
var urlAnimate = "http://mediasemantics.com/animate";

        
app.get('/animate', function(req, res, next) {
    console.log("animate");
    if (req.query.type != "audio" && req.query.type != "image" && req.query.type != "data") req.query.type = "image"; // default to image
    
    var character = "SusanHead";
    
    // TODO - delete this line if your character is always the same
    if (req.query.character) character = req.query.character
    
    // These parameters can be derived from the character if they are not supplied
    var charobj = characterObject(character);
    var charstyleobj = characterStyleObject(charobj.style);
	var width = req.query.width || charstyleobj.naturalWidth;
	var height = req.query.height || charstyleobj.naturalHeight;
	var version = req.query.version || charobj.version;
	var format = req.query.format || (charobj.style.split("-")[0] == "realistic" ? "jpeg" : "png");
    
    // Determine an appropriate voice for your character - or you can fix it here instead
    var voice = charobj.defaultVoice;

    // Allow client to override voice. TODO - delete this line if your voice is always the same.
    if (req.query.voice) voice = req.query.voice;
    
    // Build a hash of all parameters to send to the Character API
    var o = {
        "character":character,
		"version":version,
		"return":"true",
		"recover":"true",
		"format":format,
		"width":width.toString(),
		"height":height.toString(),
		"charx":"0",
		"chary":"0",
		"fps":"24",
		"quality":"95",
		"backcolor":"ffffff"
    };
    
    // Add to that any other parameters that are variable, from the client
    if (req.query.action) o.action = req.query.action;
    if (req.query.texture) o.texture = req.query.texture;
    if (req.query.with) o.with = req.query.with;
    if (req.query.charx) o.charx = req.query.charx.toString();
    if (req.query.chary) o.chary = req.query.chary.toString();
    if (req.query.lipsync) o.lipsync = req.query.lipsync;
    if (req.query.initialstate) o.initialstate = req.query.initialstate;

    // TODO - if you DO allow parameters to come from the client, then it is a good idea to limit them to what you need. E.g.:
    // if (o.character != "SteveHead" && o.character != "SusanHead") throw new Error('limit reached');  // limit characters
    // if (o.action && o.action.length > 256) throw new Error('limit reached'); // limit message length
    // if (voice != "NeuralJoanna" && voice != "NeuralMatthew") throw new Error('limit reached'); // limit voices

    // Things break further on if we don't have defaults on these
    if (!o.format) o.format = "png";
    if (!o.action) o.action = "";
    
    // Now use all these parameters to create a hash that becomes the file type
    var crypto = require('crypto');
    var hash = crypto.createHash('md5');
    for (var key in o)
        hash.update(o[key]);
    hash.update(voice);                                 // This is not a Character API parameter but it also should contribute to the hash
    if (req.query.cache) hash.update(req.query.cache);  // Client-provided cache buster that can be incremented when server code changes to defeat browser caching
    var filebase = hash.digest("hex");
    var type = req.query.type;                          // This is the type of file actually requested - audio, image, or data
    var format = o.format;                              // "png" or "jpeg"

	lockFile.lock(targetFile(filebase, "lock"), {}, function() {
        let file = targetFile(filebase, type, format);
        fs.exists(file, function(exists) {
            if (exists) {
                lockFile.unlock(targetFile(filebase, "lock"), function() {
                    // "touch" each file we return - you can use a cron to delete files older than a certain age
                    let time = new Date();
                    fs.utimes(file, time, time, () => { 
                        finish(req, res, filebase, type, o.format);
                    });
                });
            }
            else {
                // Cache miss - do the work!

                // Case where there is no tts and we can send straight to animate
                if (o.action.indexOf("<say>") == -1 || o.lipsync)
                {
                    o.key = charAPIKey;
                    o.zipdata = true;
                    console.log("---> calling animate w/ "+JSON.stringify(o));
                    var animateTimeStart = new Date();						
                    request.get({url:urlAnimate, qs: o, encoding: null}, function(err, httpResponse, body) {
                        var animateTimeEnd = new Date();						
                        console.log("<--- back from animate - " + (animateTimeEnd.getTime() - animateTimeStart.getTime()));
                        if (err) return next(new Error(body));
                        if (httpResponse.statusCode >= 400) return next(new Error(body));
                        fs.writeFile(targetFile(filebase, "image", o.format), body, "binary", function(err) {
                            if (o.texture) {
                                // texture requests don't have associated data, so we are done
                                lockFile.unlock(targetFile(filebase, "lock"), function() {
                                    finish(req, res, filebase, type, o.format);
                                });
                            }
                            else {
                                var buffer = Buffer.from(httpResponse.headers["x-msi-animationdata"], 'base64')
                                zlib.unzip(buffer, function (err, buffer) {
                                    fs.writeFile(targetFile(filebase, "data"), buffer.toString(), "binary", function(err) {					
                                        lockFile.unlock(targetFile(filebase, "lock"), function() {
                                            finish(req, res, filebase, type, o.format);
                                        });
                                    });
                                });
                            }
                        });
                    });
                }
                // Case where we need to get tts and lipsync it first
                else
                {
                    doParallelTTS(o.action, voice, function(err, audioData, lipsyncData) {
                        if (err) return next(new Error(err.message));
                        fs.writeFile(targetFile(filebase, "audio"), audioData, function (err) {
                            if (err) return next(new Error(err.message));
                            // pass the lipsync result to animate.
                            o.key = charAPIKey;
                            o.zipdata = true;
                            o.lipsync = lipsyncData;
                            // any other tag conversions
                            o.action = remainingTagsToXML(cmdTagsToXML(removeSpeechTags(o.action)));
                            console.log("---> calling animate w/ "+JSON.stringify(o));						
                            var animateTimeStart = new Date();						
                            request.get({url:urlAnimate, qs: o, encoding: null}, function(err, httpResponse, body) {
                                if (err) return next(new Error(body));
                                var animateTimeEnd = new Date();
                                console.log("<--- back from animate - " + (animateTimeEnd.getTime() - animateTimeStart.getTime()));
                                if (httpResponse.statusCode >= 400) return next(new Error(body));
                                var buffer = Buffer.from(httpResponse.headers["x-msi-animationdata"], 'base64')
                                zlib.unzip(buffer, function (err, buffer) {
                                    if (err) return next(new Error(err.message));
                                    fs.writeFile(targetFile(filebase, "image", o.format), body, "binary", function(err) {
                                        if (err) return next(new Error(err.message));
                                        fs.writeFile(targetFile(filebase, "data"), buffer.toString(), "binary", function(err) {
                                            if (err) return next(new Error(err.message));
                                            lockFile.unlock(targetFile(filebase, "lock"), function() {
                                                finish(req, res, filebase, type, o.format);
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                }
            }
        });
    });
});

function doParallelTTS(action, voice, callback) {
    var audioData;
    var lipsyncData;
    var firstErr = null;
    var audioDone = false;
    var phonemesDone = false;
    
    // Do both TTS request in parallel to save time
    
    var textOnly = action.replace(new RegExp("<[^>]*>", "g"), "").replace("  ", " "); // e.g. <say>Look <cmd/> here.</say> --> Look here.
    var neural = false;
    if (voice.substr(0,6) == "Neural") { // NeuralJoanna or Joanna
        neural = true;
        voice = voice.substr(6);
    }
    var pollyData = {
        OutputFormat: 'mp3',
        Text: msToSSML(textOnly),
        VoiceId: voice,
        Engine: (neural ? "neural" : "standard"),
        TextType: "ssml"
    };
    console.log("---> calling tts w/ " + JSON.stringify(pollyData));
    var ttsTimeStart = new Date();
    
    polly.synthesizeSpeech(pollyData, function (err, data) {
        if (err)
            firstErr = err;
        else 
            audioData = data.AudioStream;
        audioDone = true;
        if (audioDone && phonemesDone) {
            var ttsTimeEnd = new Date();
            console.log("<--- back from tts - " + (ttsTimeEnd.getTime() - ttsTimeStart.getTime()));
            callback(firstErr, audioData, lipsyncData);
        }
    });
        
    var pollyData2 = JSON.parse(JSON.stringify(pollyData));
    pollyData2.OutputFormat = 'json';
    pollyData2.SpeechMarkTypes = ['viseme'];
    
    polly.synthesizeSpeech(pollyData2, function (err, data) {
        if (err)
            firstErr = err;
        else {
            var zip = new require('node-zip')();
            zip.file('lipsync', data.AudioStream);
            lipsyncData = zip.generate({base64: true, compression: 'DEFLATE'});
        }
        phonemesDone = true;
        if (audioDone && phonemesDone) {
            var ttsTimeEnd = new Date();
            console.log("<--- back from tts - " + (ttsTimeEnd.getTime() - ttsTimeStart.getTime()));
            callback(firstErr, audioData, lipsyncData);
        }
    });
}
    
function targetFile(filebase, type, format) {
    if (type == "audio") return cachePrefix + filebase + ".mp3";
    else if (type == "image") return cachePrefix + filebase + "." + format;
    else if (type == "data") return cachePrefix + filebase + ".json";
    else if (type == "lock") return cachePrefix + filebase + ".lock";
}

function targetMime(type, format) {
    if (type == "audio") return "audio/mp3";
    else if (type == "image") return "image/" + format;
    else if (type == "data") return "application/json; charset=utf-8";
}

function finish(req, res, filebase, type, format) {
	var frstream = fs.createReadStream(targetFile(filebase, type, format));
	res.statusCode = "200";
    
    if ((req.get("Origin") || "").indexOf("localhost") != -1) res.setHeader('Access-Control-Allow-Origin', req.get("Origin"));
    // TODO: IMPORTANT: Uncomment and fill in your domain here for CORS protection
    //else if ((req.get("Origin")||"").indexOf("yourdomain.com") != -1) res.setHeader('Access-Control-Allow-Origin', req.get("Origin"));*/
	res.setHeader('Cache-Control', 'max-age=31536000, public'); // 1 year (long!)
	res.setHeader('content-type', targetMime(type, format));
	frstream.pipe(res);        
}

function msToSSML(s) {
    var ret = ssmlHelper(s, true);
    // Any remaining tags can be eliminated for tts
    ret = ret.replace(/\[[^\]]*\]/g, "").replace("  "," "); // e.g. Look [cmd] here. --> Look here.
    return ret;
}

function removeSpeechTags(s) {
    return ssmlHelper(s, false);
}

function ssmlHelper(s, use) {
    var old = s;
    
    // SSML is very strict about closing tags - we try to automatically close some tags
    if (use && s.indexOf("[conversational]") != -1 && s.indexOf("[/conversational]") == -1) s += "[/conversational]";
    if (use && s.indexOf("[news]") != -1 && s.indexOf("[/news]") == -1) s += "[/news]";

    // Super-useful [spoken]...[/spoken][written]...[/written] (take all of spoken, take none of written)
    s = s.replace(/\[spoken\](.*?)\[\/spoken\]/g, use ? "$1" : "");
    s = s.replace(/\[written\](.*?)\[\/written\]/g, use ? "" : "$1");

    // Pause
    s = s.replace(/\[silence ([0-9.]*)s\]/g, use ? '<break time="$1s"/>' : '');      // [silence 1.5s]
    s = s.replace(/\[silence ([0-9.]*)ms\]/g, use ? '<break time="$1ms"/>' : '');      // [silence 300ms]
    
    // Emphasis - note that these are not supported by polly except in non-neural, which we try to avoid, so eliminating from the speech tags for now.
    
    // Language
    s = s.replace(/\[english\]/g, use ? '<lang xml:lang="en-US">' : '');      // [english]...[/english]
    s = s.replace(/\[\/english\]/g, use ? '</lang>' : '');                    
    s = s.replace(/\[french\]/g, use ? '<lang xml:lang="fr-FR">' : '');      // [french]...[/french]
    s = s.replace(/\[\/french\]/g, use ? '</lang>' : '');                    
    s = s.replace(/\[spanish\]/g, use ? '<lang xml:lang="es">' : '');      // [spanish]...[/spanish]
    s = s.replace(/\[\/spanish\]/g, use ? '</lang>' : '');                    
    s = s.replace(/\[italian\]/g, use ? '<lang xml:lang="it">' : '');      // [italian]...[/italian]
    s = s.replace(/\[\/italian\]/g, use ? '</lang>' : '');                    
    s = s.replace(/\[german\]/g, use ? '<lang xml:lang="de">' : '');      // [german]...[/german]
    s = s.replace(/\[\/german\]/g, use ? '</lang>' : '');                    

    // Say as
    s = s.replace(/\[spell\]/g, use ? '<say-as interpret-as="characters">' : '');      // [spell]a[/spell]
    s = s.replace(/\[\/spell\]/g, use ? '</say-as>' : '');
    s = s.replace(/\[digits\]/g, use ? '<say-as interpret-as="digits">' : '');      // [digits]123[/digits]
    s = s.replace(/\[\/digits\]/g, use ? '</say-as>' : '');
    s = s.replace(/\[verb\]/g, use ? '<w role="amazon:VB">' : '');      // [verb]present[/verb]
    s = s.replace(/\[\/verb\]/g, use ? '</w>' : '');
    s = s.replace(/\[past\]/g, use ? '<w role="amazon:VBD">' : '');      // [past]present[/past]
    s = s.replace(/\[\/past\]/g, use ? '</w>' : '');
    s = s.replace(/\[alt\]/g, use ? '<w role="amazon:SENSE_1">' : '');      // [alt]bass[/alt]
    s = s.replace(/\[\/alt\]/g, use ? '</w>' : '');

    // Breathing not supported by neural, so will not include it

    s = s.replace(/\[ipa (.*?)\]/g, use ? '<phoneme alphabet="ipa" ph="$1">' : '');      // [ipa pɪˈkɑːn]pecan[/ipa]
    s = s.replace(/\[\/ipa\]/g, use ? '</phoneme>' : '');
    var m;
    while (m = s.match(/\[sampa (.*?)\]/)) {
        s = s.replace(m[0], use ? '<phoneme alphabet="x-sampa" ph="' + m[1].replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;") + '">' : '');
    }
    s = s.replace(/\[\/sampa\]/g, use ? '</phoneme>' : '');
    s = s.replace(/\[pinyin (.*?)\]/g, use ? '<phoneme alphabet="x-amazon-pinyin" ph="$1">' : '');      // [pinyin bao2]薄[/pinyin]
    s = s.replace(/\[\/pinyin\]/g, use ? '</phoneme>' : '');

    s = s.replace(/\[drc\]/g, use ? '<amazon:effect name="drc">' : '');      // [drc]dynamic range correction[/drc]
    s = s.replace(/\[\/drc\]/g, use ? '</amazon:effect>' : '');
    
    // Speaking style
    s = s.replace(/\[conversational\]/g, use ? '<amazon:domain name="conversational">' : '');      // [conversational]...[/conversational]
    s = s.replace(/\[\/conversational\]/g, use ? '</amazon:domain>' : '');
    s = s.replace(/\[news\]/g, use ? '<amazon:domain name="news">' : '');      // [news]...[/news]
    s = s.replace(/\[\/news\]/g, use ? '</amazon:domain>' : ''); 
    
    // volume
    s = s.replace(/\[volume (.*?)\]/g, use ? '<prosody volume="$1">' : '');      // [volume loud]...[/volume] [volume -6dB]...[/volume]
    s = s.replace(/\[\/volume\]/g, use ? '</prosody>' : ''); 
    // rate
    s = s.replace(/\[rate (.*?)\]/g, use ? '<prosody rate="$1">' : '');      // [rate slow]...[/rate] [rate 80%]...[/rate]
    s = s.replace(/\[\/rate\]/g, use ? '</prosody>' : ''); 
    // pitch
    s = s.replace(/\[pitch (.*?)\]/g, use ? '<prosody pitch="$1">' : '');      // [pitch high]...[/pitch] [pitch +5%]...[/pitch]
    s = s.replace(/\[\/pitch\]/g, use ? '</prosody>' : ''); 
            
    //if (use && s != old) console.log("SSML: " + old + " -> " + s);
    if (use) return "<speak>" + s + "</speak>";
    else return s;
}

function cmdTagsToXML(s) {
    // [cmd] -> <cmd/>
    // [cmd type="foo" arg="bar"] -> <cmd type="foo" arg="bar"/>
    var m,mm;
    while (m = s.match(/\[cmd(.*?)\]/)) {
        var args = m[1];
        let t = '<cmd';
        while (mm = args.match(/\w*=".*?"/)) {
            t = t + ' ' + mm[0];
            args = args.replace(mm[0],"");
		}
        t = t + '/>';
        s = s.replace(m[0], t);
    }
    return s;
}

function remainingTagsToXML(s) {
    // [headright] -> <headright/>
    s = s.replace(/\[([\w-]*?)\]/g, '<$1/>');
    // [pause 500ms] -> <pause msec="$1"/>
    s = s.replace(/\[pause (.*?)ms\]/g, '<pause msec="$1"/>');
    return s;
}

// This is handy character data, but is subject to change

var characterStyles = [
    {"id":"realistic-head", "name":"Realistic Head", "naturalWidth":250, "naturalHeight":200, "recommendedWidth":250, "recommendedHeight":200, "recommendedX":0, "recommendedY":0},
    {"id":"realistic-bust", "name":"Realistic Bust", "naturalWidth":375, "naturalHeight":300, "recommendedWidth":275, "recommendedHeight":300, "recommendedX":-50, "recommendedY":0},
    {"id":"realistic-body", "name":"Realistic Body", "naturalWidth":500, "naturalHeight":400, "recommendedWidth":300, "recommendedHeight":400, "recommendedX":-100, "recommendedY":0},
    {"id":"hd-head", "name":"High Definition", "naturalWidth":250, "naturalHeight":200, "recommendedWidth":250, "recommendedHeight":200, "recommendedX":0, "recommendedY":0},
    {"id":"hd-head-2x", "name":"High Definition", "naturalWidth":500, "naturalHeight":400, "recommendedWidth":500, "recommendedHeight":400, "recommendedX":0, "recommendedY":0},
    {"id":"hd-head-3x", "name":"High Definition", "naturalWidth":750, "naturalHeight":600, "recommendedWidth":750, "recommendedHeight":600, "recommendedX":0, "recommendedY":0},
    {"id":"illustrated-head", "name":"Illustrated Head", "naturalWidth":250, "naturalHeight":200, "recommendedWidth":250, "recommendedHeight":200, "recommendedX":0, "recommendedY":0},
    {"id":"illustrated-body", "name":"Illustrated Body", "naturalWidth": 307, "naturalHeight": 397, "recommendedWidth":300, "recommendedHeight":400, "recommendedX":0, "recommendedY":0},
    {"id":"cs", "name":"Cartoon Solutions", "naturalWidth": 307, "naturalHeight": 397, "recommendedWidth":300, "recommendedHeight":400, "recommendedX":0, "recommendedY":0},
    {"id":"classic", "name":"Classic Cartoon", "naturalWidth": 307, "naturalHeight": 397, "recommendedWidth":300, "recommendedHeight":400, "recommendedX":0, "recommendedY":0},
    {"id":"cgi-head", "name":"CG Cartoon Head", "naturalWidth":250, "naturalHeight":200, "recommendedWidth":250, "recommendedHeight":200, "recommendedX":0, "recommendedY":0},
    {"id":"cgi-bust", "name":"CG Cartoon Bust", "naturalWidth":375, "naturalHeight":300, "recommendedWidth":275, "recommendedHeight":300, "recommendedX":-50, "recommendedY":0},
    {"id":"cgi-body", "name":"CG Cartoon Body", "naturalWidth":500, "naturalHeight":400, "recommendedWidth":300, "recommendedHeight":400, "recommendedX":-100, "recommendedY":0}
];

var characters = [
    {"id":"SteveHead", "style":"realistic-head", "name":"Steve", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/SteveHead.gif"},
    {"id":"SusanHead", "style":"realistic-head", "name":"Susan", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/SusanHead.gif"},
    {"id":"RobertHead", "style":"realistic-head", "name":"Robert", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/RobertHead.gif"},
    {"id":"AnnaHead", "style":"realistic-head", "name":"Anna", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/AnnaHead.gif"},
    {"id":"BenHead", "style":"realistic-head", "name":"Ben", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/BenHead.gif"},
    {"id":"AngelaHead", "style":"realistic-head", "name":"Angela", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.5", "thumb":"img/characters/AngelaHead.gif"},
    {"id":"GeneHead", "style":"realistic-head", "name":"Gene", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/GeneHead.gif"},
    {"id":"KateHead", "style":"realistic-head", "name":"Kate", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/KateHead.gif"},
    {"id":"LeeHead", "style":"realistic-head", "name":"Lee", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/LeeHead.gif"},
    {"id":"LilyHead", "style":"realistic-head", "name":"Lily", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/LilyHead.gif"},

    {"id":"CarlaHead", "style":"cgi-head", "name":"Carla", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.1", "thumb":"img/characters/CarlaHead.gif"},
    {"id":"CarlHead", "style":"cgi-head", "name":"Carl", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.1", "thumb":"img/characters/CarlHead.gif"},

    {"id":"TomHead", "style":"illustrated-head", "format":"head", "name":"Tom", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.2", "thumb":"img/characters/TomHead.gif"},
    {"id":"TashaHead", "style":"illustrated-head", "format":"head", "name":"Tasha", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.2", "thumb":"img/characters/TashaHead.gif"},
    {"id":"RickHead", "style":"illustrated-head", "format":"head", "name":"Rick", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"2.2", "thumb":"img/characters/RickHead.gif"},
    {"id":"JimHead", "style":"illustrated-head", "format":"head", "name":"Jim", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.2", "thumb":"img/characters/JimHead.gif"},
    {"id":"MeganHead", "style":"illustrated-head", "format":"head", "name":"Megan", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.2", "thumb":"img/characters/MeganHead.gif"},
    {"id":"KarmaJon", "style":"illustrated-head", "format":"head", "name":"Jon", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/Custom.gif", "tag":"karma"},

    {"id":"SteveBust", "style":"realistic-bust", "name":"Steve", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/SteveBust.gif"},
    {"id":"SusanBust", "style":"realistic-bust", "name":"Susan", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/SusanBust.gif"},
    {"id":"RobertBust", "style":"realistic-bust", "name":"Robert", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/RobertBust.gif"},
    {"id":"AnnaBust", "style":"realistic-bust", "name":"Anna", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/AnnaBust.gif"},
    {"id":"BenBust", "style":"realistic-bust", "name":"Ben", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/BenBust.gif"},
    {"id":"AngelaBust", "style":"realistic-bust", "name":"Angela", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.5", "thumb":"img/characters/AngelaBust.gif"},
    {"id":"GeneBust", "style":"realistic-bust", "name":"Gene", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/GeneBust.gif"},
    {"id":"KateBust", "style":"realistic-bust", "name":"Kate", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/KateBust.gif"},
    {"id":"LeeBust", "style":"realistic-bust", "name":"Lee", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/LeeBust.gif"},
    {"id":"LilyBust", "style":"realistic-bust", "name":"Lily", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/LilyBust.gif"},

    {"id":"CarlaBust", "style":"cgi-bust", "name":"Carla", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.1", "thumb":"img/characters/CarlaBust.gif"},
    {"id":"CarlBust", "style":"cgi-bust", "name":"Carl", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.1", "thumb":"img/characters/CarlBust.gif"},

    {"id":"SteveBody", "style":"realistic-body", "name":"Steve", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/SteveBody.gif"},
    {"id":"SusanBody", "style":"realistic-body", "name":"Susan", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/SusanBody.gif"},
    {"id":"RobertBody", "style":"realistic-body", "name":"Robert", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/RobertBody.gif"},
    {"id":"AnnaBody", "style":"realistic-body", "name":"Anna", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/AnnaBody.gif"},
    {"id":"BenBody", "style":"realistic-body", "name":"Ben", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/BenBody.gif"},
    {"id":"AngelaBody", "style":"realistic-body", "name":"Angela", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.5", "thumb":"img/characters/AngelaBody.gif"},
    {"id":"GeneBody", "style":"realistic-body", "name":"Gene", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/GeneBody.gif"},
    {"id":"KateBody", "style":"realistic-body", "name":"Kate", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/KateBody.gif"},
    {"id":"LeeBody", "style":"realistic-body", "name":"Lee", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/LeeBody.gif"},
    {"id":"LilyBody", "style":"realistic-body", "name":"Lily", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/LilyBody.gif"},

    {"id":"CarlaBody", "style":"cgi-body", "name":"Carla", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.1", "thumb":"img/characters/CarlaBody.gif"},
    {"id":"CarlBody", "style":"cgi-body", "name":"Carl", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.1", "thumb":"img/characters/CarlBody.gif"},
    
    {"id":"TomBody", "style":"illustrated-body", "name":"Tom", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.2", "thumb":"img/characters/TomBody.gif"},
    {"id":"TashaBody", "style":"illustrated-body", "name":"Tasha", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.2", "thumb":"img/characters/TashaBody.gif"},
    {"id":"RickBody", "style":"illustrated-body", "name":"Rick", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"2.2", "thumb":"img/characters/RickBody.gif"},
    {"id":"JimBody", "style":"illustrated-body", "name":"Jim", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.2", "thumb":"img/characters/JimBody.gif"},
    {"id":"MeganBody", "style":"illustrated-body", "name":"Megan", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.2", "thumb":"img/characters/MeganBody.gif"},

    {"id":"CSDoug", "style":"cs", "name":"Doug", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/CSDoug.gif"},
    {"id":"CSDenise", "style":"cs", "name":"Denise", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.0", "thumb":"img/characters/CSDenise.gif"},
    {"id":"CSPhil", "style":"cs", "name":"Phil", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/CSPhil.gif"},
    {"id":"CSSophia", "style":"cs", "name":"Sophia", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.0", "thumb":"img/characters/CSSophia.gif"},
    {"id":"CSEmikoFront", "style":"cs", "name":"Emiko", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.0", "thumb":"img/characters/CSEmikoFront.gif"},
    {"id":"CSRichardFront", "style":"cs", "name":"Richard", "gender":"male", "defaultVoice":"Joey", "version":"1.0", "thumb":"img/characters/CSRichardFront.gif"},
    {"id":"CSVeronicaFront", "style":"cs", "name":"Veronica", "gender":"female", "defaultVoice":"Salli", "version":"1.0", "thumb":"img/characters/CSVeronicaFront.gif"},
    {"id":"CSWyattFront", "style":"cs", "name":"Wyatt", "gender":"male", "defaultVoice":"Joey", "version":"1.0", "thumb":"img/characters/CSWyattFront.gif"},
    {"id":"CSSantaFront", "style":"cs", "name":"Santa", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/CSSantaFront.gif"},
    {"id":"CSFelixFoxFront", "style":"cs", "name":"Felix Fox", "gender":"male", "defaultVoice":"Joey", "version":"1.0", "thumb":"img/characters/CSFelixFoxFront.gif"},
    {"id":"CSAngela", "style":"cs", "name":"Angela", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.0", "thumb":"img/characters/CSAngela.gif"},
    {"id":"CSMaleek", "style":"cs", "name":"Maleek", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/CSMaleek.gif"},
    {"id":"CSDonaldTrump", "style":"cs", "name":"Donald Trump", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/CSDonaldTrump.gif"},

    {"id":"Brad", "style":"classic", "name":"Brad", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.2", "thumb":"img/characters/Brad.gif"},
    {"id":"Kim", "style":"classic", "name":"Kim", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.2", "thumb":"img/characters/Kim.gif"},
    {"id":"Charlie", "style":"classic", "name":"Charlie", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/Charlie.gif"},
    {"id":"Al", "style":"classic", "name":"Al", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/Al.gif"},
    {"id":"Wolly", "style":"classic", "name":"Wolly", "gender":"male", "defaultVoice":"Joey", "version":"2.4", "thumb":"img/characters/Wolly.gif"},
    
    {"id":"MichelleHead", "style":"hd-head", "name":"Michelle", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.1", "thumb":"img/characters/MichelleHead.gif"},
    {"id":"MichelleHead2x", "style":"hd-head-2x", "name":"Michelle", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.1", "thumb":"img/characters/MichelleHead.gif"},
    {"id":"MichelleHead3x", "style":"hd-head-3x", "name":"Michelle", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.1", "thumb":"img/characters/MichelleHead.gif"},
];

function characterStyleObject(id) {
    for (var i = 0; i < characterStyles.length ; i++)
        if (characterStyles[i].id == id)
            return characterStyles[i];
    return null;
}
    
function characterObject(id) {
    for (var i = 0; i < characters.length ; i++)
        if (characters[i].id == id)
            return characters[i];
    return null;
}


app.listen(3000, function() {
  console.log('Listening on port 3000');
});
