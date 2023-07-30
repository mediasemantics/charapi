var express = require('express');
var bodyParser = require('body-parser');
var fs = require('fs');
var request = require('request');
var AWS = require('aws-sdk');
var zlib = require('zlib');
var lockFile = require('lockfile');

// TODO set up your Character API key here
var charAPIKey = "xxxxxxxxxxxxxxxxxxxxxxxxx";

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

// The Character API endpoints

var urlCatalog = "http://api.mediasemantics.com/catalog";
var urlAnimate = "http://api.mediasemantics.com/animate";

// The animation catalog
var catalog = null;
var catalogTimestamp = null;
var CATALOG_TTL = 60 * 60 * 1000; // 1 hour

app.get('/animate', function(req, res, next) {
    console.log("animate");
    if (req.query.type != "audio" && req.query.type != "image" && req.query.type != "model" && req.query.type != "data") req.query.type = "image"; // default to image

    loadCatalogIfNecessary(function(e){
        if (e) return next(e);
        
        var character;
        var version;
        
        // The client specifies the character
        if (req.query.character) character = req.query.character;
        // And a precise version - this lets you upgrade to a new character and clear all levels of caching
        if (req.query.version) version = req.query.version;
        
        // These parameters can technically be derived from the character if they are not supplied
        var charobj = characterObject(character);
        var charstyleobj = characterStyleObject(charobj.style);
        var width = req.query.width || charstyleobj.naturalWidth;
        var height = req.query.height || charstyleobj.naturalHeight;
        var density = req.query.density || "1";
        var charscale = req.query.charscale || "1";
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
            "density":density,
            "charscale":charscale,
            "charx":"0",
            "chary":"0",
            "fps":"24",
            "quality":"95",
            "backcolor":"ffffff",
            "do":req.query.do,
            "say":req.query.say,
        };
    
        // Add to that any other parameters that are variable, from the client
        if (req.query.texture) o.texture = req.query.texture;
        if (req.query.with) o.with = req.query.with;
        if (req.query.charx) o.charx = req.query.charx.toString();
        if (req.query.chary) o.chary = req.query.chary.toString();
        if (req.query.lipsync) o.lipsync = req.query.lipsync;
        if (req.query.initialstate) o.initialstate = req.query.initialstate;
        if (req.query.return) o.return = req.query.return;        

        // TODO - if you DO allow parameters to come from the client, then it is a good idea to limit them to what you need. E.g.:
        // if (o.character != "SteveHead" && o.character != "SusanHead") throw new Error('limit reached');  // limit characters
        // if (o.say && o.say.length > 256) throw new Error('limit reached'); // limit message length
        // if (voice != "NeuralJoanna" && voice != "NeuralMatthew") throw new Error('limit reached'); // limit voices

        // Things break further on if we don't have defaults on these
        if (!o.format) o.format = "png";
        
        if (o.do || o.say) o["with"] = "all";  // all but the initial empty action requests that output be generated that assumes we will fetch all textures
        
        // Now use all these parameters to create a hash that becomes the file type
        var crypto = require('crypto');
        var hash = crypto.createHash('md5');
        for (var key in o)
            hash.update(o[key]||"");
        hash.update(voice);                                 // This is not a Character API parameter but it also should contribute to the hash
        if (req.query.cache) hash.update(req.query.cache);  // Client-provided cache buster that can be incremented when server code changes, to defeat browser caching
        var filebase = hash.digest("hex");
        var type = req.query.type;                          // This is the type of file actually requested - audio, image, model, or data
        var format = o.format;                              // "png" or "jpeg"

        // NOTE: A more scaleable implementation, optimized for load balancers, would use redis and ioredis-lock.
        lockFile.lock(targetFile(filebase, "lock"), {}, function() {
            let file = targetFile(filebase, type, format);
            fs.exists(file, function(exists) {
                if (exists) {
                    lockFile.unlock(targetFile(filebase, "lock"), function() {
                        // "touch" each file we return - you can use a cron to delete files older than a certain age
                        let time = new Date();
                        fs.utimes(file, time, time, () => { 
                            finishAnimate(req, res, filebase, type, o.format);
                        });
                    });
                }
                else {
                    // Cache miss - do the work!

                    // Case where there is no tts and we can send straight to animate
                    if (!containsActualSpeech(o.say) || o.lipsync)
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
                            fs.writeFile(targetFile(filebase, type, o.format), body, "binary", function(err) {
                                if (o.texture) {
                                    // texture requests don't have associated data, so we are done
                                    lockFile.unlock(targetFile(filebase, "lock"), function() {
                                        finishAnimate(req, res, filebase, type, o.format);
                                    });
                                }
                                else {
                                    var buffer = Buffer.from(httpResponse.headers["x-msi-animationdata"], 'base64')
                                    zlib.unzip(buffer, function (err, buffer) {
                                        fs.writeFile(targetFile(filebase, "data"), buffer.toString(), "binary", function(err) {					
                                            lockFile.unlock(targetFile(filebase, "lock"), function() {
                                                finishAnimate(req, res, filebase, type, o.format);
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
                        var textOnly = removeAllButSpeechTags(o.say);
                        doParallelTTS(textOnly, voice, function(err, audioData, lipsyncData) {
                            if (err) return next(new Error(err.message));
                            fs.writeFile(targetFile(filebase, "audio"), audioData, function (err) {
                                if (err) return next(new Error(err.message));
                                // pass the lipsync result to animate.
                                o.key = charAPIKey;
                                o.zipdata = true;
                                o.lipsync = lipsyncData;
                                o.say = removeSpeechTags(o.say);
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
                                                    finishAnimate(req, res, filebase, type, o.format);
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
});

function containsActualSpeech(say) {
    if (!say) return false;
    let textOnly = say.replace(/\[[^\]]*\]/g, ""); // e.g. "Look [cmd] here." --> "Look here."
    if (!textOnly) return false;
    let hasNonWhitespace = !!textOnly.match(/\S/);
    return hasNonWhitespace;
}

function loadCatalogIfNecessary(callback) {
    var timestampNow = (new Date()).getTime();
    if (!catalog || !catalogTimestamp || catalogTimestamp - timestampNow > CATALOG_TTL) {
        console.log("---> calling catalog");
        var catalogTimeStart = new Date();						
        request.get(urlCatalog + "?key="+charAPIKey, function(err, httpResponse, body) {
            var catalogTimeEnd = new Date();						
            console.log("<--- back from catalog - " + (catalogTimeEnd.getTime() - catalogTimeStart.getTime()));
            if (err) return callback(err);
            if (httpResponse.statusCode != 200) return callback(new Error(body));
            catalog = JSON.parse(body);
            catalogTimestamp = timestampNow;
            callback(null);
        });
    }
    else {
        callback(null);
    }
}

function doParallelTTS(textOnly, voice, callback) {
    var audioData;
    var lipsyncData;
    var firstErr = null;
    var audioDone = false;
    var phonemesDone = false;
    
    // Do both TTS request in parallel to save time
    
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
    else if (type == "model") return cachePrefix + filebase + ".glb";
    else if (type == "data") return cachePrefix + filebase + ".json";
    else if (type == "lock") return cachePrefix + filebase + ".lock";
}

function targetMime(type, format) {
    if (type == "audio") return "audio/mp3";
    else if (type == "image") return "image/" + format;
    else if (type == "model") return "model/gltf-binary";
    else if (type == "data") return "application/json; charset=utf-8";
}

function finishAnimate(req, res, filebase, type, format) {
	var frstream = fs.createReadStream(targetFile(filebase, type, format));
	res.statusCode = "200";
    
    res.setHeader('Access-Control-Allow-Origin', req.get("Origin"));  // This line removes all CORS protection!
    // TODO: IMPORTANT: Remove line above and uncomment lines below, filling in your domain, for CORS protection
    //if ((req.get("Origin")||"").indexOf("localhost") != -1) res.setHeader('Access-Control-Allow-Origin', req.get("Origin")); // allow testing on localhost
    //else if ((req.get("Origin")||"").indexOf("yourdomain.com") != -1) res.setHeader('Access-Control-Allow-Origin', req.get("Origin"));
    res.setHeader('Vary', 'Origin');
	res.setHeader('Cache-Control', 'max-age=31536000, public'); // 1 year (long!)
	res.setHeader('content-type', targetMime(type, format));
	frstream.pipe(res);        
}

function msToSSML(s) { // e.g. "[silence] Look here." --> "<break time="1s"/> Look here."    
    var ret = ssmlHelper(s, 1);
    // Any remaining tags can be eliminated for tts
    ret = ret.replace(/\[[^\]]*\]/g, "").replace("  "," "); // e.g. Look [cmd] here. --> Look here.
    return ret;
}

function removeSpeechTags(s) {  // e.g. "[silence] Look [blink] here." --> "Look [blink] here."    
    let temp = ssmlHelper(s, 2);
    temp = temp.replace(/  /g, " ").trim();
    return temp;
}

function removeAllButSpeechTags(s) {  // e.g. "[silence] Look [blink] here." --> "[silence] Look here."    
    let temp = ssmlHelper(s, 3);
    temp = temp.replace(new RegExp("\[[^\]]*\]", "g"), "").replace("  ", " ").trim(); // e.g. "Look [cmd] here." --> "Look here."    
    temp = temp.replace(/\{/g,'[');
    temp = temp.replace(/\}/g,']');
    return temp;
}

function ssmlHelper(s, c) {
    //var old = s;
    
    // SSML is very strict about closing tags - we try to automatically close some tags
    if (c==1 && s.indexOf("[conversational]") != -1 && s.indexOf("[/conversational]") == -1) s += "[/conversational]";
    if (c==1 && s.indexOf("[news]") != -1 && s.indexOf("[/news]") == -1) s += "[/news]";

    // Super-useful [spoken]...[/spoken][written]...[/written] (take all of spoken, take none of written)
    s = s.replace(/\[spoken\](.*?)\[\/spoken\]/g, c==1 ? "$1" : (c==2 ? '$1': '{spoken}$1{/spoken}'));
    s = s.replace(/\[written\](.*?)\[\/written\]/g, c==1 ? "" : (c==2 ? '': '{written}$1{/written}'));

    // Pause
    s = s.replace(/\[silence\]/g, c==1 ? '<break time="1s"/>' : (c==2 ? '': '[silence]'));      // [silence]
    s = s.replace(/\[silence ([0-9.]*)s\]/g, c==1 ? '<break time="$1s"/>' : (c==2 ? '': '[silence $1s]'));      // [silence 1.5s]
    s = s.replace(/\[silence ([0-9.]*)ms\]/g, c==1 ? '<break time="$1ms"/>' : (c==2 ? '': '[silence $1ms]'));      // [silence 300ms]
    
    // Emphasis - note that these are not supported by polly except in non-neural, which we try to avoid, so eliminating from the speech tags for now.
    
    // Language
    s = s.replace(/\[english\]/g, c==1 ? '<lang xml:lang="en-US">' : (c==2 ? '': '{english}'));      // [english]...[/english]
    s = s.replace(/\[\/english\]/g, c==1 ? '</lang>' : (c==2 ? '': '{/english}'));                    
    s = s.replace(/\[french\]/g, c==1 ? '<lang xml:lang="fr-FR">' : (c==2 ? '': '{french}'));      // [french]...[/french]
    s = s.replace(/\[\/french\]/g, c==1 ? '</lang>' : (c==2 ? '': '{/french}'));                    
    s = s.replace(/\[spanish\]/g, c==1 ? '<lang xml:lang="es">' : (c==2 ? '': '{spanish}'));      // [spanish]...[/spanish]
    s = s.replace(/\[\/spanish\]/g, c==1 ? '</lang>' : (c==2 ? '': '{/spanish}'));                    
    s = s.replace(/\[italian\]/g, c==1 ? '<lang xml:lang="it">' : (c==2 ? '': '{italian}'));      // [italian]...[/italian]
    s = s.replace(/\[\/italian\]/g, c==1 ? '</lang>' : (c==2 ? '': '{/italian}'));                    
    s = s.replace(/\[german\]/g, c==1 ? '<lang xml:lang="de">' : (c==2 ? '': '{german}'));      // [german]...[/german]
    s = s.replace(/\[\/german\]/g, c==1 ? '</lang>' : (c==2 ? '': '{/german}'));                    

    // Say as
    s = s.replace(/\[spell\]/g, c==1 ? '<say-as interpret-as="characters">' : (c==2 ? '': '{spell}'));      // [spell]a[/spell]
    s = s.replace(/\[\/spell\]/g, c==1 ? '</say-as>' : (c==2 ? '': '{/spell}'));
    s = s.replace(/\[digits\]/g, c==1 ? '<say-as interpret-as="digits">' : (c==2 ? '': '{digits}'));      // [digits]123[/digits]
    s = s.replace(/\[\/digits\]/g, c==1 ? '</say-as>' : (c==2 ? '': '{/digits}'));
    s = s.replace(/\[verb\]/g, c==1 ? '<w role="amazon:VB">' : (c==2 ? '': '{verb}'));      // [verb]present[/verb]
    s = s.replace(/\[\/verb\]/g, c==1 ? '</w>' : (c==2 ? '': '{/verb}'));
    s = s.replace(/\[past\]/g, c==1 ? '<w role="amazon:VBD">' : (c==2 ? '': '{past}'));      // [past]present[/past]
    s = s.replace(/\[\/past\]/g, c==1 ? '</w>' : (c==2 ? '': '{/past}'));
    s = s.replace(/\[alt\]/g, c==1 ? '<w role="amazon:SENSE_1">' : (c==2 ? '': '{alt}'));      // [alt]bass[/alt]
    s = s.replace(/\[\/alt\]/g, c==1 ? '</w>' : (c==2 ? '': '{/alt}'));

    // Breathing not supported by neural, so will not include it

    s = s.replace(/\[ipa (.*?)\]/g, c==1 ? '<phoneme alphabet="ipa" ph="$1">' : (c==2 ? '': '{ipa $1}'));      // [ipa pɪˈkɑːn]pecan[/ipa]
    s = s.replace(/\[\/ipa\]/g, c==1 ? '</phoneme>' : (c==2 ? '': '{/ipa}'));
    var m;
    while (m = s.match(/\[sampa (.*?)\]/)) {
        s = s.replace(m[0], c==1 ? '<phoneme alphabet="x-sampa" ph="' + m[1].replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;") + '">' : (c==2 ? '': '{sampa $1}'));
    }
    s = s.replace(/\[\/sampa\]/g, c==1 ? '</phoneme>' : (c==2 ? '': '{/sampa}'));
    s = s.replace(/\[pinyin (.*?)\]/g, c==1 ? '<phoneme alphabet="x-amazon-pinyin" ph="$1">' : (c==2 ? '': '{pinyin}'));      // [pinyin bao2]薄[/pinyin]
    s = s.replace(/\[\/pinyin\]/g, c==1 ? '</phoneme>' : (c==2 ? '': '{/pinyin}'));

    s = s.replace(/\[drc\]/g, c==1 ? '<amazon:effect name="drc">' : (c==2 ? '': '{drc}'));      // [drc]dynamic range correction[/drc]
    s = s.replace(/\[\/drc\]/g, c==1 ? '</amazon:effect>' : (c==2 ? '': '{/drc}'));
    
    // Speaking style
    s = s.replace(/\[conversational\]/g, c==1 ? '<amazon:domain name="conversational">' : (c==2 ? '': '{conversational}'));      // [conversational]...[/conversational]
    s = s.replace(/\[\/conversational\]/g, c==1 ? '</amazon:domain>' : (c==2 ? '': '{/conversational}'));
    s = s.replace(/\[news\]/g, c==1 ? '<amazon:domain name="news">' : (c==2 ? '': '{news}'));      // [news]...[/news]
    s = s.replace(/\[\/news\]/g, c==1 ? '</amazon:domain>' : (c==2 ? '': '{/news}')); 
    
    // volume
    s = s.replace(/\[volume (.*?)\]/g, c==1 ? '<prosody volume="$1">' : (c==2 ? '': '{volume $1}'));      // [volume loud]...[/volume] [volume -6dB]...[/volume]
    s = s.replace(/\[\/volume\]/g, c==1 ? '</prosody>' : (c==2 ? '': '{/volume}')); 
    // rate
    s = s.replace(/\[rate (.*?)\]/g, c==1 ? '<prosody rate="$1">' : (c==2 ? '': '{rate $1}'));      // [rate slow]...[/rate] [rate 80%]...[/rate]
    s = s.replace(/\[\/rate\]/g, c==1 ? '</prosody>' : (c==2 ? '': '{/rate}')); 
    // pitch
    s = s.replace(/\[pitch (.*?)\]/g, c==1 ? '<prosody pitch="$1">' : (c==2 ? '': '{pitch $1}'));      // [pitch high]...[/pitch] [pitch +5%]...[/pitch]
    s = s.replace(/\[\/pitch\]/g, c==1 ? '</prosody>' : (c==2 ? '': '{/pitch}')); 
            
    //if (use && s != old) console.log("SSML: " + old + " -> " + s);
    if (c==1) return "<speak>" + s + "</speak>";
    else return s;
}

// Catalog lookup 

function characterStyleObject(id) {
    for (var i = 0; i < catalog.characterStyles.length ; i++)
        if (catalog.characterStyles[i].id == id)
            return catalog.characterStyles[i];
    return null;
}
    
function characterObject(id) {
    for (var i = 0; i < catalog.characters.length ; i++)
        if (catalog.characters[i].id == id)
            return catalog.characters[i];
    return null;
}


app.listen(3000, function() {
  console.log('Listening on port 3000');
});
