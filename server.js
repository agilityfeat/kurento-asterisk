/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var path = require('path');
var express = require('express');
var ws = require('ws');
var minimist = require('minimist');
var url = require('url');
var kurento = require('kurento-client');
var fs    = require('fs');
var https = require('https');
var SIP = require('sip.js');

var argv = minimist(process.argv.slice(2), {
  default: {
      as_uri: "https://localhost:8443/",
      ws_uri: "ws://107.22.152.22:8111/kurento"
  }
});

const OVERLAY_URL = 'https://github.com/Kurento/kurento-tutorial-node/raw/master/kurento-magic-mirror/static/img/mario-wings.png';

var options =
{
  key:  fs.readFileSync('keys/server.key'),
  cert: fs.readFileSync('keys/server.crt')
};

var app = express();

/*
 * Definition of global variables.
 */

var kurentoClient = null;
var userRegistry = new UserRegistry();
var pipelines = {};
var candidatesQueue = {};
var idCounter = 0;
var sipServer = '107.22.152.22';

function nextUniqueId() {
    idCounter++;
    return idCounter.toString();
}

const IDLE = 0;
const INCOMING_CALL = 1;
const OUTGOING_CALL = 2;

/*
 * Definition of helper classes
 */

// Represents caller and callee sessions
function UserSession(id, ext, ua, ws) {
    this.id = id;
    this.ext = ext;
    this.ws = ws;
    this.ua = ua;
    this.sdpOffer = null;
    this.asteriskSdp = null;
    // this.generateAsteriskOffer = null;
    this.endPoint = null;
    this.callStatus = IDLE
}

UserSession.prototype.sendMessage = function(message) {
    this.ws.send(JSON.stringify(message));
}

UserSession.prototype.setEndPoint = function(endPoint) {
    this.endPoint = endPoint;
}

// Represents registrar of users
function UserRegistry() {
    this.usersById = {};
    this.usersByExt = {};
}

UserRegistry.prototype.getById = function(id) {
    return this.usersById[id];
}

UserRegistry.prototype.getByExt = function(ext) {
    return this.usersByExt[ext];
}

UserRegistry.prototype.register = function(user) {
    this.usersById[user.id] = user;
    this.usersByExt[user.ext] = user;
}

UserRegistry.prototype.unregister = function(id) {
    var user = this.getById(id);
    if (user) delete this.usersById[id];
    if (user) delete this.usersByExt[user.ext];
}

UserRegistry.prototype.removeById = function(id) {
    var userSession = this.usersById[id];
    if (!userSession) return;
    delete this.usersById[id];
    delete this.usersByExt[userSession.ext];
}

/* **************************************************
    We implemented a custom media handler for SIP.js
    that would take care of handling session descriptions
    for the Kurento - Asterisk communication.
************************************************** */
function KurentoMediaHandler(ext, session, options) {
  this.session = session;
  this.ext     = ext;
}

KurentoMediaHandler.prototype = {

    isReady: function () { return true; },

    close: function () {},

    peerConnection: {
        close: new Function()
    },

    render: new Function(),
    mute: new Function(),
    unmute: new Function(),

    getDescription: function (onSuccess, onFailure, mediaHint) {
        let user = userRegistry.getByExt(this.ext);
        if(user.asteriskSdp.type === 'answer') {
            onSuccess(user.asteriskSdp.value);
        } else if (user.pipeline) {
            user.pipeline.rtpEndPoint.processOffer(user.asteriskSdp.value).then(onSuccess).catch(onFailure);
        }
    },

    setDescription: function (desc, onSuccess, onFailure) {
        let user = userRegistry.getByExt(this.ext);
        user.asteriskSdp = {
            type: 'offer',
            value: desc
        }; 
        onSuccess();
    }
};

// Represents a B2B active call
function CallMediaPipeline() {
    this.pipeline = null;
    this.webRtcEndpoint = null;
    this.rtpEndPoint = null;
}


/* *****************************
    We implemented a simple Kurento media pipeline with a WebRtcEndpoint to 
    connect to the web client, a RtpEndpoint to connect to Asterisk and a 
    FaceOverlayFilter to apply the overlay image on top of the video stream
    *************************** */
CallMediaPipeline.prototype.createPipeline = function(userId, ws, callback) {
    var self = this;
    getKurentoClient(function(error, kurentoClient) {
        if (error) {
            return callback(error);
        }

        kurentoClient.create('MediaPipeline', function(error, pipeline) {
            if (error) {
                return callback(error);
            }

            let endPoints = [
                {type: "RtpEndpoint", params: {}},
                {type: "WebRtcEndpoint", params: {}},
                {type: "FaceOverlayFilter", params: {}},
            ];

            pipeline.create(endPoints, function(error, [rtpEndPoint, webEndPoint, faceFilter]) {

                let user = userRegistry.getById(userId);

                rtpEndPoint.on('ConnectionStateChanged', (evt) => {
                    console.log(`RtpEndpoint(${user.ext})`, `${evt.oldState} => ${evt.newState}`)
                });

                webEndPoint.on('ConnectionStateChanged', (evt) => {
                    console.log(`WebRTCEndpoint(${user.ext})`, `${evt.oldState} => ${evt.newState}`)
                });
                
                if (error) {
                    pipeline.release();
                    return callback(error);
                }

                if (candidatesQueue[userId]) {
                    while(candidatesQueue[userId].length) {
                        var candidate = candidatesQueue[userId].shift();
                        webEndPoint.addIceCandidate(candidate);
                    }
                }

                webEndPoint.on('OnIceCandidate', function(event) {
                    var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                    userRegistry.getById(userId).ws.send(JSON.stringify({
                        id : 'iceCandidate',
                        candidate : candidate
                    }));
                });

                let promises = [
                    faceFilter.setOverlayedImage(OVERLAY_URL, -0.35, -1.2, 1.6, 1.6),
                    
                    webEndPoint.connect(faceFilter),
                    rtpEndPoint.connect(webEndPoint),
                    faceFilter.connect(rtpEndPoint)
                ];

                Promise.all(promises).then(() => {
                    self.rtpEndPoint = rtpEndPoint;
                    self.webRtcEndpoint = webEndPoint;
                    self.pipeline = pipeline;
                    callback(null);
                }).catch(callback);

            });
        });
    })
}

CallMediaPipeline.prototype.generateSdpAnswer = function(sdpOffer, callback) {
    this.webRtcEndpoint.processOffer(sdpOffer, callback);
    this.webRtcEndpoint.gatherCandidates(function(error) {
        if (error) {
            return callback(error);
        }
    });
}

CallMediaPipeline.prototype.release = function() {
    if (this.pipeline) this.pipeline.release();
    this.pipeline = null;
}

/*
 * Server startup
 */

var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server : server,
    path : '/one2one'
});

wss.on('connection', function(ws) {
    var sessionId = nextUniqueId();
    console.log('Connection received with sessionId ' + sessionId);

    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
        userRegistry.unregister(sessionId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
        case 'register':
            register(sessionId, message.ext, message.password, ws);
            break;

        case 'call':
            call(sessionId, message.to, message.sdpOffer);
            break;

        case 'incomingCallResponse':
            incomingCallResponse(sessionId, message.callResponse, message.sdpOffer, ws);
            break;

        case 'stop':
            stop(sessionId);
            break;

        case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;

        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + message
            }));
            break;
        }

    });
});

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            var message = 'Coult not find media server at address ' + argv.ws_uri;
            return callback(message + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function stop(sessionId) {
    
    var user = userRegistry.getById(sessionId);

    if (user) {
        user.pipeline && user.pipeline.release();
        user.pipeline = null;

        var message = {
            id: 'stopCommunication',
            message: 'remote user hanged out'
        }
        user.sendMessage(message)
    }

    clearCandidatesQueue(sessionId);
}

function incomingCallResponse(calleeId, callResponse, calleeSdp, ws) {

    clearCandidatesQueue(calleeId);

    var callee = userRegistry.getById(calleeId);
    callee.sdpOffer = calleeSdp;

    if (callResponse === 'accept') {
        createCallPipeline(callee, (error, sdpAnswer) => {

            /* ***************************************************
                If the callee accepted the call, a Kurento media 
                pipeline is created and the RTPEndPoint processes 
                the SDP offer we got from Asterisk
            *************************************************** */
            callee.pipeline.rtpEndPoint.processOffer(callee.asteriskSdp.value).then((answer) => {
                callee.asteriskSdp = {
                    type: 'answer', 
                    value: answer
                };
                callee.session.accept();
            });
            
            // We let the client know everything's ready to begin streaming
            var message = {
                id: 'startCommunication',
                sdpAnswer
            };
            callee.sendMessage(message);
        }); 
    } else {
        callee.session.reject();
    }
}

function createCallPipeline(user, callback) {
    let pipeline = new CallMediaPipeline();
    pipeline.createPipeline(user.id, ws, function(error) {
        if (error) {
            pipeline.release();
            return callback(error);
        }

        pipeline.generateSdpAnswer(user.sdpOffer, function(error, sdpAnswer) {
            if (error) {
                pipeline.release();
                return callback(error);
            }

            user.pipeline = pipeline;
            console.log(`${user.ext} <- pipeline`);
            callback(null, sdpAnswer);
        });
    });
}

function setupCallSession(user) {
    
    function rejectCall(rejectCause) {
        var message  = {
            id: 'callResponse',
            response: 'rejected',
            message: rejectCause
        };
        user.session = null;
        user.sendMessage(message);
    }

    function terminateCall(evt) {
        console.log('TERMINATED', evt.reason_phrase);
        user.pipeline && user.pipeline.release();
        user.pipeline = null;
        if(user.session) {
            user.session = null;
            stop(user.id);
        }
    }
    
    // This can be omitted 
    user.session.on('progress', () => console.log('SESSION: progress'));
    user.session.on('cancel', () => console.log('SESSION: cancel'));
    user.session.on('refer', () => console.log('SESSION: refer'));
    user.session.on('replaced', () => console.log('SESSION: replaced'));
    user.session.on('dtmf', () => console.log('SESSION: dtmf'));
    user.session.on('muted', () => console.log('SESSION: muted'));
    user.session.on('unmuted', () => console.log('SESSION: unmuted'));
    user.session.on('bye', () => console.log('SESSION: bye'));

    user.session.on('terminated', terminateCall);
    user.session.on('failed', terminateCall);
    user.session.on('rejected', terminateCall);

    // This would tell a caller that its INVITE was accepted
    user.session.on('accepted', () => {
        let message = {
            id: 'callResponse',
            response : 'accepted',
            sdpAnswer: user.sdpAnswer
        };
        user.sendMessage(message);
    });

    // Afterwards a Kurento media pipeline is created to initiate communication
    createCallPipeline(user, (error, sdpAnswer) => {
        if(error) {
            if(user.pipeline) user.pipeline.release();
            console.log('Error', error);
            rejectCall(JSON.stringify(error));
        } else {
            user.sdpAnswer = sdpAnswer;
        }
    });
}

function call(callerId, to, sdpOffer) {
    clearCandidatesQueue(callerId);

    var caller = userRegistry.getById(callerId);
    caller.callStatus = OUTGOING_CALL;
    caller.sdpOffer = sdpOffer;

    function onError(callerReason) {
        if (pipeline) pipeline.release();
        if (caller) {
            var callerMessage = {
                id: 'callResponse',
                response: 'rejected'
            }
            if (callerReason) callerMessage.message = callerReason;
            caller.sendMessage(callerMessage);
        }
    }

    /* ***************************************************
        When a call is originated on the web client, an INVITE
        is sent to Asterisk, where it will routed to its 
        destination or handled according to the dial plan
    *************************************************** */
    if(!caller.session) {
        console.log(`${caller.ext} calling ${to} ...`);
        var session = caller.ua.invite(`sip:${to}@${sipServer}`, {
            inviteWithoutSdp: true
        });
        caller.session = session;
        setupCallSession(caller);
    } else {
        console.log('Session xists', caller.session);
    }
}

function makeHandlerFactory(ext) {
    return (session, opts) => {
        return new KurentoMediaHandler(ext, session, opts);
    }
}
/* ***************************************************
    When a client asks to be registered, a SIP user agent is created 
*************************************************** */
function register(id, ext, password, ws, callback) {
    function onError(error) {
        ws.send(JSON.stringify({id:'registerResponse', response : 'rejected ', message: error}));
    }

    if (!ext) {
        return onError("empty user ext");
    }

    if (userRegistry.getByExt(ext)) {
        return onError("User " + ext + " is already registered");
    }

    var userAgent = new SIP.UA({
        uri: `sip:${ext}@${sipServer}`,
        wsServers: [`ws://${sipServer}:8088/ws`],
        authorizationUser: ext,
        stunServers: ['stun:107.22.152.22:3478'],
        password,
        mediaHandlerFactory: makeHandlerFactory(ext),
        hackIpInContact: true,
        traceSip: false
    });
    userRegistry.register(new UserSession(id, ext, userAgent, ws));

    userAgent.on('registered', () => {
        console.log(`SIP client registered for ${ext}`);
        try {
            ws.send(JSON.stringify({id: 'registerResponse', response: 'accepted'}));
        } catch(exception) {
            onError(exception);
        }
    });

    /* **********************************
        When an INVITE message is received, 
        the web client is notified that there's an 
        incoming call. The user decides if she accepts
        it or rejects it/
    ********************************** */
    userAgent.on('invite', (session) => {

        var fromExt = 'Anonymous';
        if(session.request.headers.From && session.request.headers.From[0]) {
            let [ext, _] = session.request.headers.From[0].raw.split(';');
            fromExt = ext;
        }
            
        let callee = userRegistry.getById(id);
        if(callee.session) {
            session.reject();
        } else {
            callee.session = session;
            let message = {
                id: 'incomingCall',
                from: fromExt
            };
            callee.sendMessage(message);
        }
    });

    userAgent.on('disconnect', function() {
        console.log(`${id}:${ext} user agent disconnected`);
    });
}

function clearCandidatesQueue(sessionId) {
    if (candidatesQueue[sessionId]) {
        delete candidatesQueue[sessionId];
    }
}

function onIceCandidate(sessionId, _candidate) {
    var candidate = kurento.getComplexType('IceCandidate')(_candidate);
    var user = userRegistry.getById(sessionId);

    if (pipelines[user.id] && pipelines[user.id].webRtcEndpoint && pipelines[user.id].webRtcEndpoint[user.id]) {
        var webRtcEndpoint = pipelines[user.id].webRtcEndpoint[user.id];
        webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        if (!candidatesQueue[user.id]) {
            candidatesQueue[user.id] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

app.use(express.static(path.join(__dirname, 'static')));
