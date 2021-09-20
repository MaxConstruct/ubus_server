//=============================================================================
// University Bus Management
// Rangsit University
// file: server.js
// created date: 14/02/2021
//=============================================================================

const express = require('express');
const dgram = require('dgram');
const fs = require('fs');
const app = express();

const mysql = require('mysql');
const bcrypt = require('bcrypt');

const https = require('https');

const multer = require('multer');
const multer_upload = multer({ dest: 'uploads/' });

const path = require('path');

const { Parser } = require('json2csv');

const privateKey = fs.readFileSync( 'cert/private.key' );
const certificate = fs.readFileSync( 'cert/cert.pem' );

const bus_print = function(...args){
    console.log(`\x1b[32m[UBUS]\x1b[0m `+args.join('')+`.`);
}

const bus_error = function(...args){
    console.log(`\x1b[31m[UBUS]\x1b[0m `+args.join('')+`.`);
}

const database = mysql.createConnection({
    host: "localhost",
    user: "bus",
    password: "11501150",
    database: "ubus"
});

const config = {
    "ssl": true
}

let bus_location = {};
let station = {};

function CalculateDistance(lat1, lon1, lat2, lon2) 
{
    let R = 6371;
    let dLat = (lat2-lat1) * Math.PI / 180;
    let dLon = (lon2-lon1) * Math.PI / 180;
    lat1 = lat1 * Math.PI / 180;
    lat2 = lat2 * Math.PI / 180;

    let a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.sin(dLon/2) * Math.sin(dLon/2) * Math.cos(lat1) * Math.cos(lat2); 
    let c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    return (R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)))).toFixed(2);
}

const getCurrentStation = function(lat, lng){
    for(let i in station){
        let dist = CalculateDistance(lat, lng, station[i].lat, station[i].lng);
        if(dist <= (station[i].radius ? station[i].radius : 0.05)){
            return i
        }
    }
}

const insertLog = function(message, unique){
    database.query(mysql.format("INSERT INTO logs(message, message_unique) VALUES(?, ?);", [message, unique ? unique : null]));
}

database.connect(function(err) {
    if (err) throw err;

    bus_print("Connected to database.");
    insertLog(`Initiated the bus sequence.`);

    database.query("SELECT * FROM vehicles", function (err, result, fields) {
        if (err) throw err;
        
        for(let i in result){
            let d = result[i];
            bus_location[d.u_id] = {
                name: d.u_name,
                desc: d.u_desc,
                lat: d.lat,
                lng: d.lng,
                head: d.head ? d.head : 0,
                upTime: Math.floor(+new Date() / 1000),
            }
        }
        bus_print("Previous vehicle data has been initialized.");
    });

    database.query("SELECT * FROM station", function (err, result, fields) {
        if (err) throw err;
        
        for(let i in result){
            let d = result[i];
            station[d.id] = {
                name: d.name,
                desc: d.desc,
                lat: d.lat,
                lng: d.lng,
                radius: d.radius,
                order: d.order,
            }
        }
       
        bus_print("Previous station data has been initialized.");
    });
});

socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function SaveLocationCache(){
    try {
        for(let i in bus_location){
            let d = bus_location[i];
            database.query(mysql.format("UPDATE vehicles SET lat = ?, lng = ?, heading = ? WHERE u_id = ?", [d.lat, d.lng, d.head, i]));
        }
    }catch(err){
        bus_error(err.toString());
    }
}

function TimedLocationSaver(){
    SaveLocationCache();
}

let AllowCORS = function(res){
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
}

socket.on('message', function (msg, info){
    let pack = msg.toString();
    try{
        pack = JSON.parse(pack);
        if(pack){
            if(pack.lat && pack.lng && pack.bid){
                if(bus_location[pack.bid]){
                    bus_location[pack.bid].lat = pack.lat;
                    bus_location[pack.bid].lng = pack.lng;
                    bus_location[pack.bid].head = pack.head ? pack.head : 0;
                    bus_location[pack.bid].upTime = Math.floor(+new Date() / 1000);
                    
                    let station = getCurrentStation(pack.lat, pack.lng);
                    if(station && bus_location[pack.bid].station != station){
                        insertLog(`Bus ${bus_location[pack.bid].name} is at station ${station}`, pack.bid);
                    }else if(!station && bus_location[pack.bid].station){
                        delete bus_location[pack.bid].station;
                    }
                    
                    bus_location[pack.bid].station = station;
                    bus_print(`Location updated for bus id: ${pack.bid} {lat:${pack.lat}, lng:${pack.lng}}`);
                }
            }
        }
    }catch(err){
        console.log(err)
    }
});

socket.on('listening', function(){
    let address = socket.address();
    bus_print('Location service is now online. ('+ address.address +':'+ address.port +')');

    setInterval(function(){
        TimedLocationSaver();
    }, 5000)
});

socket.bind(44044);

var token_storage = {};
const generateToken = function(n) {
    let chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let token = '';
    for(let i = 0; i < n; i++) {
        token += chars[Math.floor(Math.random() * chars.length)];
    }
    return token;
}

app.get('/location', async (req, res) => {
    AllowCORS(res);

    let token = req.query.token;
    if(token){
        res.json(bus_location[token]);
        return;
    }

    res.json(bus_location);
});

app.post('/v1/login', async (req, res) => {
    AllowCORS(res);

    let body = req.body;
    
    if(!body.email){ res.status(400).json({err_desc:"no email was specify."}); return; }
    if(!body.password){ res.status(400).json({err_desc:"no password was specify."}); return; }

    database.query(mysql.format("SELECT * FROM users WHERE email = ?",[
        body.email
    ]), function (err, result, fields) {
        if(result[0]){
            if (bcrypt.compareSync(body.password, result[0].password)) {
                res.json({
                    code: 200,
                    data: result[0]
                });
            }else{
                res.status(401).json({
                    code: 401,
                    desc: "Email or password is invalid!"
                });
            }
        }else{
            res.status(401).json({
                code: 401,
                desc: "No account on this email!"
            });
        }
    });
});

app.post('/v1/bus/create', async (req, res) => {
    AllowCORS(res);

    let body = req.body;
    if(!body.name){ res.status(400).json({err_desc:"no name was specify."}); return; }
    if(!body.desc){ res.status(400).json({err_desc:"no desc was specify."}); return; }

    let token = generateToken(7);
	token_storage[token] = {
        name: body.name,
        desc: body.desc,
		created_time: new Date()
	}
	res.json({token:token});
});

app.post('/v1/bus/edit', async (req, res) => {
    AllowCORS(res);

    let body = req.body;
    if(!body.car_id){ res.status(400).json({err_desc:"no car_id was specify."}); return; }
    if(!body.name){ res.status(400).json({err_desc:"no name was specify."}); return; }
    if(!body.desc){ res.status(400).json({err_desc:"no desc was specify."}); return; }

    if(bus_location[body.car_id]){
        bus_location[body.car_id].name = body.name;
        bus_location[body.car_id].desc = body.desc;
        
        database.query(mysql.format("UPDATE vehicles SET u_name = ?, u_desc = ? WHERE u_id = ?", [body.name, body.name, body.car_id]));
        bus_print(`Updated ${body.car_id}.`);
        res.json({state:true})
    }else{
        res.json({state:false})
    }
});

app.delete('/v1/bus/destroy', async (req, res) => {
    AllowCORS(res);

    let body = req.body;
    if(!body.car_id){ res.status(400).json({err_desc:"no car_id was specify."}); return; }

    if(bus_location[body.car_id]){
        delete bus_location[body.car_id];
        database.query(mysql.format("DELETE FROM vehicles WHERE u_id = ?", [body.car_id]));
        bus_print(`Destroyed ${body.car_id}.`);
        res.json({state:true})
    }else{
        res.json({state:false})
    }
});

app.get('/v1/bus/pending', async (req, res) => {
    AllowCORS(res);
	res.json({data:token_storage});
});

app.post('/v1/bus/scan', async (req, res) => {
    AllowCORS(res);
    let body = req.body;
    if(!body.token){ res.status(400).json({err_desc:"no uid was specify."}); return; }

    let token = body.token;
	if(token_storage[token]){
        let temp = token_storage[token];

        database.query(mysql.format("INSERT INTO vehicles(u_id, u_name, u_desc) VALUES(?, ?, ?);", [token, temp.name, temp.desc]), function(err){
            if (err) {
                console.log(err);
                return;
            };
            bus_location[token] = {
                name: temp.name,
                desc: temp.desc,
                lat: 0,
                lng: 0,
                head: 0,
                upTime: Math.floor(+new Date() / 1000),
                fresh: true
            };
            
            delete token_storage[token];
            res.json({id:token, data:token_storage});
        });
    }else{
        res.status(400).json({err_desc:"invalid token."});
    }
});

app.post('/v1/station/create', async (req, res) => {
    AllowCORS(res);

    let body = req.body;
    if(!body.name){ res.status(400).json({err_desc:"no name was specify."}); return; }
    if(!body.desc){ res.status(400).json({err_desc:"no desc was specify."}); return; }
    if(!body.lat){ res.status(400).json({err_desc:"no lat was specify."}); return; }
    if(!body.lng){ res.status(400).json({err_desc:"no lng was specify."}); return; }

    let radius = (body.radius) ? parseFloat(body.radius) : 0.05;
    if(isNaN(radius)){
        radius = 0.05;
    }

	database.query(mysql.format("INSERT INTO station(`name`, `desc`, `lat`, `lng`, `radius`, `order`) VALUES(?, ?, ?, ?, ?, ?);", [
        body.name,
        body.desc,
        parseFloat(body.lat),
        parseFloat(body.lng),
        radius,
        body.order ? parseInt(body.order) : 0,
    ]), function(err, result){
        if (err) {
            console.log(err);
            return;
        };
        
        let id = result.insertId;
        station[id] = {
            name: body.name,
            desc: body.desc,
            lat: parseFloat(body.lat),
            lng: parseFloat(body.lng),
            radius: radius,
            order: body.order ? parseInt(body.order) : 0,
        }
        
        res.json({code:200, data:{
            id: result.insertId,
            data: station[id]
        }});
    });
});

app.post('/v1/station/edit', async (req, res) => {
    AllowCORS(res);

    let body = req.body;
    if(!body.id){ res.status(400).json({err_desc:"no id was specify."}); return; }

    let id = parseInt(body.id);
    if(station[id]){
        if(body.name) station[id].name = body.name;
        if(body.desc) station[id].desc = body.desc;
        if(body.lat) station[id].lat = parseFloat(body.lat);
        if(body.lng) station[id].lng = parseFloat(body.lng);
        if(body.radius) station[id].radius = parseFloat(body.radius);
        if(body.order) station[id].order = parseInt(body.order);
        
        database.query(mysql.format("UPDATE station SET `name` = ?, `desc` = ?, `lat` = ?, `lng` = ?, `radius` = ?, `order` = ? WHERE id = ?", [
            station[id].name,
            station[id].desc,
            station[id].lat,
            station[id].lng,
            station[id].radius,
            station[id].order,
            id
        ]));

        bus_print(`Updated station ${id}.`);
        res.json({state:true})
    }else{
        res.json({state:false})
    }
});

app.delete('/v1/station/destroy', async (req, res) => {
    AllowCORS(res);

    let body = req.body;
    if(!body.id){ res.status(400).json({err_desc:"no id was specify."}); return; }

    let station_id = parseInt(body.id);
    if(station[station_id]){
        delete station[station_id];
        database.query(mysql.format("DELETE FROM station WHERE id = ?", [station_id]));
        bus_print(`Destroyed station_id ${station_id}.`);
        res.json({state:true})
    }else{
        res.json({state:false})
    }
});

app.get('/v1/station/list', async (req, res) => {
    AllowCORS(res);
    res.json(station)
});

app.get('/v1/advert/list', async (req, res) => {
    AllowCORS(res);

	database.query("SELECT * FROM advertisement LIMIT 10", function(err, result){
        if (err) {
            console.log(err);
            return;
        };
        
        res.json({code:200, data:result});
    });
});

app.post('/v1/advert/create', async (req, res) => {
    AllowCORS(res);

    let body = req.body;
    if(!body.title){ res.status(400).json({err_desc:"no title was specify."}); return; }
    if(!body.image){ res.status(400).json({err_desc:"no image was specify."}); return; }

	database.query(mysql.format("INSERT INTO advertisement(`a_title`, `a_image`) VALUES(?, ?);", [
        body.title,
        body.image,
    ]), function(err, result){
        if (err) {
            console.log(err);
            return;
        };
        
        res.json({code:200, data:{
            title: body.title,
            image: body.image,
        }});
    });
});

app.post('/v1/advert/edit', async (req, res) => {
    AllowCORS(res);

    let body = req.body;
    if(!body.id){ res.status(400).json({err_desc:"no id was specify."}); return; }
    if(!body.title || !body.image){ res.status(400).json({err_desc:"no data was specify."}); return; }

    let ad_id = parseInt(body.id);
    database.query(mysql.format("UPDATE advertisement SET `a_title` = ?, `a_image` = ? WHERE id = ?", [
        body.title,
        body.image,
        ad_id
    ]), function(err, result){
        res.json({code:200, state:true});
    });
});

app.delete('/v1/advert/destroy', async (req, res) => {
    AllowCORS(res);

    let body = req.body;
    if(!body.id){ res.status(400).json({err_desc:"no id was specify."}); return; }

    let ad_id = parseInt(body.id);
    database.query(mysql.format("DELETE FROM advertisement WHERE id = ?", [ad_id]));
    res.json({code:200, state:true})
});

if(config.ssl){
    https.createServer({
        key: privateKey,
        cert: certificate
    }, app).listen(2096, () => {
        bus_print('Express service is now online. (SSL: ON)');
    });
}else{
    app.listen(3500, () => {
        bus_print('Express service is now online. (127.0.0.1:3500)')
    });
}

app.get('/v1/log/get', async (req, res) => {
    AllowCORS(res);

    let page = req.query.page ? parseInt(req.query.page) : 1;
    let limit = req.query.limit ? parseInt(req.query.limit) : 30;

    let unique = req.query.unique ? req.query.unique : null;
    let should_csv = req.query.csv;

    let start_time = req.query.start;
    let end_time = req.query.end;

    let query, query2;
    if(start_time && end_time){
        start_time = moment.unix(start_time).toDate();
        end_time = moment.unix(end_time).toDate();

        if(unique){
            query = mysql.format("SELECT COUNT(message) as counted FROM logs WHERE message_unique = ? AND message_time BETWEEN ? AND ?", [unique, start_time, end_time]);
            query2 = mysql.format("SELECT * FROM logs WHERE message_unique = ? AND message_time BETWEEN ? AND ? ORDER BY message_time ASC", [unique, start_time, end_time]);
        }else{
            query = mysql.format("SELECT COUNT(message) as counted FROM logs WHERE message_unique IS NOT NULL AND message_time BETWEEN ? AND ?", [start_time, end_time]);
            query2 = mysql.format("SELECT * FROM logs WHERE message_unique IS NOT NULL AND message_time BETWEEN ? AND ? ORDER BY message_time ASC", [start_time, end_time]);
        }
    }else{
        if(unique){
            query = mysql.format("SELECT COUNT(message) as counted FROM logs WHERE message_unique = ?", [unique]);
            query2 = mysql.format("SELECT * FROM logs WHERE message_unique = ? ORDER BY message_time DESC LIMIT ? OFFSET ?", [unique, limit, limit * (page-1)]);
        }else{
            query = "SELECT COUNT(message) as counted FROM logs WHERE message_unique IS NOT NULL";
            query2 = mysql.format("SELECT * FROM logs WHERE message_unique IS NOT NULL ORDER BY message_time DESC LIMIT ? OFFSET ?", [limit, limit * (page-1)]);
        }
    }
    
    database.query(query, function (err, result, fields) {
        let count = result && result[0] ? result[0].counted : 0;
        database.query(query2, function (err, result, fields) {
            if(should_csv){
                const fields = ['message', 'message_unique', 'message_time'];
                const opts = { fields, withBOM: true, excelStrings: true };

                try {
                    const parser = new Parser(opts);
                    const csv = parser.parse(result);
                    res.attachment('ubus_log.csv');
                    res.send(csv)
                } catch (err) {
                    console.error(err);
                }
            }else{
                res.json({code:200, count: count, data:result})
            }
        });
    });
});

//* Extended Function

app.post('/upload/image', multer_upload.single("image"), async (req, res, next) => {
    if(!req.file){
        res.json({code:400, err_code:4029});
        return;
    }
    
    let file_path = req.file.path;
    let file_ext = path.extname(req.file.originalname).toLowerCase();
    if(file_ext === ".png" || file_ext === ".jpg" || file_ext === ".jpeg"){
        const target = path.join(__dirname, "./uploads/"+req.file.filename+file_ext);
        fs.rename(file_path, target, err => {
            res.json({code:200, path:(req.body.real ? (req.protocol + '://' + req.get('host') + "/") : "")+"images/"+req.file.filename+file_ext});
        });
    }else{
        fs.unlink(file_path, err => {
            res.json({code:400, err_code:4030});
        });
    }
});

app.use('/images', express.static(path.join(__dirname, '/uploads')));