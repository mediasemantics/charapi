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

// The Character API endpoints

var urlCatalog = "http://mediasemantics.com/catalog";
var urlAnimate = "http://mediasemantics.com/animate";

// The animation catalog
var catalog = null;
var catalogTimestamp = null;
var CATALOG_TTL = 60 * 60 * 1000; // 1 hour

        
app.get('/animate', function(req, res, next) {
    console.log("animate");
    if (req.query.type != "audio" && req.query.type != "image" && req.query.type != "data") req.query.type = "image"; // default to image

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
        
        // Derive the low-level action from the high-level tag+say pair
        var action;
        setRandomSeed(req.query.say);
        var actionTemplate = getActionTemplateFromTag(req.query.tag, o.character);
        action = getActionFromActionTemplate(actionTemplate, req.query.say, req.query.audio, req.query.bob||true, o.character);
        o.action = action;
        if (action) o["with"] = "all";  // all but the initial empty action requests that output be generated that assumes we will fetch all textures
        
        // Now use all these parameters to create a hash that becomes the file type
        var crypto = require('crypto');
        var hash = crypto.createHash('md5');
        for (var key in o)
            hash.update(o[key]);
        hash.update(voice);                                 // This is not a Character API parameter but it also should contribute to the hash
        if (req.query.cache) hash.update(req.query.cache);  // Client-provided cache buster that can be incremented when server code changes, to defeat browser caching
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
                        var textOnly = action.replace(new RegExp("<[^>]*>", "g"), "").replace("  ", " "); // e.g. <say>Look <cmd/> here.</say> --> Look here.
                        doParallelTTS(textOnly, voice, function(err, audioData, lipsyncData) {
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
});

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

function actionCategoryObject(id) {
    for (var i = 0; i < catalog.actionCategories.length ; i++)
        if (catalog.actionCategories[i].id == id)
            return catalog.actionCategories[i];
    return null;
}

function getActionTemplateFromTag(tag, character) {
    var style = characterObject(character).style;
    for (var i = 0; i < catalog.actions.length; i++) {
        if (catalog.actions[i].id == tag) {
            var category = actionCategoryObject(catalog.actions[i].category);
            if (!category || !category.characterStyles || category.characterStyles.indexOf(style) != -1)  // Because characters that don't support a certain action should ignore that action
                return catalog.actions[i].xml;
        }
    }
    return "";
}

// Seeded random

var seed = 1;

function setRandomSeed(say) {
    say = say||"";
    // Seed our random with the say text
    seed = 1;
    for (var i = 0; i < say.length; i++)
        seed += 13 * say.charCodeAt(i);
}
    
function seededRandom() {
    var x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
}

function getActionFromActionTemplate(action, say, audiotag, bob, character) {
    var style = characterObject(character).style;
    var hd = style.split("-")[0] == "hd";
    if (say || audiotag) {
        say = say||"";
        say = say.replace(/&/g, "&amp;");
        say = say.replace(/</g, "&lt;");
        say = say.replace(/>/g, "&gt;"); 
        say = say.replace(/'/g, "&apos;");
        //console.log("seed="+seed+" bob="+bob);
        // action: "<lookleft/><gestureleft/><cmd type='apogee'>+{max:5}+<lookuser/><handsbyside/>+{max:0,user:1}"
        var a = action ? action.split("+") : ["{max:0,user:1}"];  // latter is the default Look At User (user=1 means character is looking at the user)
        // e.g. a = ["{max:0,user:1}"]
        //      a = ["<lookleft/><gestureleft/><cmd type='apogee'>", "{max:5}", "<lookuser/><handsbyside/>", "{max:0,user:1}"]
        var b = splitSay(say); // e.g. ["this", "is", "a", "test"]
        var j = 0; // index into b
        var wordsSinceBlink = 0;
        var s = "";
        for (var i = 0; i < a.length; i++) {
            if (a[i].substr(0,1) != '{') {
                s += a[i]; // regular action commands
            }
            else {
                var rec = JSON.parse(a[i].replace('max','"max"').replace('user','"user"').replace('silence','"silence"')); // quick parse
                if (rec.silence) {
                    s += '[silence ' + rec.silence + 'ms]';
                    continue;
                }                    
                var c = rec.max;
                // Case where there were no (or few) words - i.e. user used an audio file but neglected to give us a script, or an unusually short script - insert a pause
                if (c > 0 && b.length <= 3)
                    s += "<pause/>";
                if (hd) {
                    if (rec.user)
                        s += '<fill name="speak1"/> ';
                    // peel off up to max words (or all the words)
                    while (j < b.length && (c > 0 || rec.max == 0)) { // while there are words left and we have not exceeded our max, if any
                        s += b[j];  // add next word
                        if (j < b.length - 1) { // if this is not the last word, add a space
                            s += " ";
                        }
                        j++;
                        c--;
                    }
                }
                else {
                    // peel off up to max words (or all the words)
                    while (j < b.length && (c > 0 || rec.max == 0)) { // while there are words left and we have not exceeded our max, if any
                        s += b[j];  // add next word
                        if (j < b.length - 1) { // if this is not the last word, add a space OR a command
                            if (!rec.user)
                                s += " "; // there can be no head-bob here, e.g. head turned - and might as well not blink either
                            else {
                                if (bob && j < b.length - 5 && seededRandom() < 0.33) { // roughly 1/3 words get a bob, but not right towards the end
                                    s += randomHead();
                                }
                                else if (wordsSinceBlink > 10) {
                                    s += " <blink/> ";
                                    wordsSinceBlink = 0;
                                }
                                else s += " ";
                            }
                        }
                        wordsSinceBlink++;
                        j++;
                        c--;
                    }
                }
            }
        }
        action = "<say>" + s + "</say>";
    }
    else {
        // Case where user has no script or audio tag - just an action - now we need to interpret our tags a bit differently
        var a = action ? action.split("+") : [];
        var s = "";
        for (var i = 0; i < a.length; i++) {
            if (a[i].substr(0,1) != '{') {
                s += a[i]; // regular action commands
            }
            else {
                var rec = JSON.parse(a[i].replace('max','"max"').replace('user','"user"'));
                if (rec.max) s += "<pause/>"; // this is what we had before our switch to +{}+ commands
            }
        }
        action = s;
    }
    return action;
}

function splitSay(say) {
    // like say.split(" ") but [] count as one word
    var a = [];
    var p1 = say.indexOf("[");
    while (p1 != -1) {
        var p2 = say.indexOf("]", p1);
        a = a.concat(say.substr(0, p1).split(" "));
        a.push(say.substr(p1, p2-p1+1));
        say = say.substr(p2+1);
        p1 = say.indexOf("[");
    }
    a = a.concat(say.split(" "));
    return a;
}

function randomHead() {
    var n = (1+Math.floor(seededRandom()*4));
    if (n == 3) return " <headnormal/> "
    else return " <headrandom"+n+"/> ";
}

app.listen(3000, function() {
  console.log('Listening on port 3000');
});
