var express = require('express');
var app = express();
var server = require('http').createServer(app);
var io = require('socket.io')(server);
var path = require("path");
var Q = require('q');
var fs = require('fs');
var lo = require('lodash');
var jsforce = require('jsforce');
var csvWriter = require('csv-write-stream');
var sleep = require('system-sleep');
var sf_deploy_url = '';
var sf_deploy_username = '';
var sf_deploy_password = '';
var pageClient = null;
var errorOccurred = true;

var bodyParser = require('body-parser');
app.use( bodyParser.json() );       // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
  extended: true
}));

app.get('/home', function(req, res) {
  res.sendFile(path.join(__dirname + '/getCoverage.html'));
});

app.get('/result', function(req, res) {
  res.sendFile(path.join(__dirname + '/teststats.html'));
});

io.on('connection', function(client) {
  console.log('Client connected...');
  pageClient = client;

  client.on('join', function(data){
    console.log(data);
    var sfLogin = JSON.parse(data);
    sf_deploy_url = sfLogin.sfUrl;
    sf_deploy_username = sfLogin.sfUserName;
    sf_deploy_password = sfLogin.sfPwd;
    queueSteps();
  });
});

server.listen(3000);

console.log("Coverage Engine is successfully started. You can open http://localhost:3000/home now to retrieve test coverage.");

/** The salesforce client */
var sfdc_client = null;

/** A map of class Ids to class information */
var id_to_class_map = {};

/** A map of test class Ids to class information */
var test_class_map = {};
var classes_to_be_recompiled = {};
var html_testClasses_seeAllData = '';
var apexJobID;

/** A map of the coverage stats */
var coverage_stats = {};

/** File name to write the CSV data to */
var CSVFilename = 'teststats.csv';
/** File name to write the HTML data to */
var HTMLFilename = 'teststats.html';


/**
* Log into the salsforce instance
*/
var sfdcLogin = function () {
	'use strict';

	var deferred = Q.defer();

	console.log('Logging in as ' + sf_deploy_username);
	pageClient.emit('messages', 'Logging in as ' + sf_deploy_username);
	sfdc_client = new jsforce.Connection({loginUrl : 'https://' + sf_deploy_url, version:'36.0'});

	sfdc_client.login(sf_deploy_username, sf_deploy_password, function (error, res) {
		if (error) {
	    	pageClient.emit('messages', 'Error Occurred: ' + error);
			deferred.reject(new Error(error));
		} else {
			console.log('Logged in');
	    	pageClient.emit('messages', 'Logged in');
			deferred.resolve();
		}
	});

	return deferred.promise;
};

/**
* Logout of the salsforce instance
*/
var sfdcLogout = function () {
	'use strict';

	var deferred = Q.defer();
	sfdc_client.logout(function (error, res) {
		if (error) {
			deferred.reject(new Error(error));
			pageClient.emit('message', 'Error Occurred - ' + error);
		} else {
			console.log('Logged out');
		        pageClient.emit('messages', 'Logged out');
			deferred.resolve();
		}
	});

	return deferred.promise;
};

/**
* Builds a map of class id to class data
*/
var buildClassIdToClassDataMap = function () {
	'use strict';

	var deferred = Q.defer();

	console.log('Fetching class information');
	pageClient.emit('messages', 'Fetching class information');

	sfdc_client.tooling.sobject('ApexClass').find({NamespacePrefix:'',Status:'Active'},{Id:1,Name:1,Body:1,IsValid:1}).execute(function (error, data) {
		if (error) {
			deferred.reject(new Error(error));
		} else {
			console.log('Got information about ' + lo.size(data) + ' classes');

			lo.forEach(data, function (row) {
				if (!row.IsValid) {
					console.log('WARNING: Class ' + row.Name + ' needs to be recompiled for proper test coverage');
					classes_to_be_recompiled[row.Name] = row.Name;
				}
				if (row.Body.toLowerCase().indexOf('@istest') === -1) {
					id_to_class_map[row.Id] = {
						name: row.Name,
						source: row.Body,
						coverage: []
					};
				} else {
					test_class_map[row.Id] = {
						name: row.Name,
						source: row.Body,
						usesSeeAllData: row.Body.toLocaleLowerCase().includes('seealldata'),
						failures: []
					};
					if (test_class_map[row.Id].usesSeeAllData) {
						console.log('WARNING: ' + test_class_map[row.Id].name + ' uses seeAllData annotation.');
						html_testClasses_seeAllData = html_testClasses_seeAllData + '\t<li>' + row.Name + '</li>';
					}
				}
			});
			console.log('There are ' + lo.size(id_to_class_map) + ' classes and ' + lo.size(test_class_map) + ' test classes.');
			pageClient.emit('messages', 'There are ' + lo.size(id_to_class_map) + ' classes and ' + lo.size(test_class_map) + ' test classes.');

			deferred.resolve();
		}
	});

	return deferred.promise;
};

var buildAddTriggersToClassIDMap = function () {
	'use strict';

	var deferred = Q.defer();

	console.log('Fetching trigger information');
	pageClient.emit('messages', 'Fetching trigger information');

	// Get the Trigger info too
	sfdc_client.tooling.sobject('ApexTrigger').find({NamespacePrefix:'',Status:'Active'},{Id:1,Name:1,Body:1,IsValid:1}).execute(function (error, triggerData) {
		if (error) {
			deferred.reject(new Error(error));
		} else {
			console.log('Got information about ' + lo.size(triggerData) + ' triggers');
			pageClient.emit('messages', 'Got information about ' + lo.size(triggerData) + ' triggers');

			lo.forEach(triggerData, function (row) {
				if (!row.IsValid) {
					console.log('WARNING: Trigger ' + row.Name + ' needs to be recompiled for proper test coverage');
					classes_to_be_recompiled[row.Name] = row.Name;
				}
				if (row.Body.toLowerCase().indexOf('@istest') === -1) {
					id_to_class_map[row.Id] = {
						name: row.Name,
						source: row.Body,
						coverage: []
					};
				} else {
					test_class_map[row.Id] = {
						name: row.Name,
						source: row.Body
					};
				}
			});

			deferred.resolve();
		}
	});
}

/**
* Runs all tests with the tooling api
*/
var runAllTests = function () {
	'use strict';

	var class_ids = lo.keys(test_class_map),
		deferred = Q.defer();

	sfdc_client.tooling.runTestsAsynchronous(class_ids, function (error, data) {
		if (error) {
			deferred.reject(new Error(error));
		} else {
			apexJobID = data;
			deferred.resolve(data);
		}
	});

	return deferred.promise;
};

/**
* Query the test results
*
* @param testRunId The id of the test run
* @param deferred The Q.defer instance
*/
var queryTestResults = function myself(testRunId, deferred) {
	'use strict';

	var isComplete = true;

	var pending = 0;

	sfdc_client.query('select Id, Status, ApexClassId from ApexTestQueueItem where ParentJobId = \'' + testRunId + '\'', function (error, data) {
		if (error) {
			deferred.reject(new Error(error));
		} else {
			lo.each(data.records, function (row) {
				if (row.Status === 'Queued' || row.Status === 'Processing') {
					isComplete = false;
					pending++;
				}
			});

			if (isComplete) {
				deferred.resolve();
			} else {
				pageClient.emit('messages', 'There are ' + pending + ' test methods still running, sleeping for ' + pending + ' seconds before checking again.');
				console.log('There are ' + pending + ' still running, sleeping for ' + pending + ' seconds before checking again.');
				sleep(pending *1000);
				myself(testRunId, deferred);
			}
		}
	});
};

/**
* Waits until all tests are completed
*
* @param testRunId The id of the test run
*/
var waitUntilTestsComplete = function (testRunId) {
	'use strict';

	var deferred = Q.defer();
	console.log('Waiting for tests');
	queryTestResults(testRunId, deferred);

	return deferred.promise;
};

/**
* After test completion get any failed test details
*/
var queryFailedTests = function () {
	'use strict';
	var deferred = Q.defer();
	pageClient.emit('messages', 'Checking for failed tests (' + apexJobID + ')');
	console.log('Checking for failed tests (' + apexJobID + ')');

	sfdc_client.query('SELECT Id, Outcome, ApexClassId, MethodName, Message, StackTrace FROM ApexTestResult WHERE Outcome = \'Fail\' AND AsyncApexJobId = \'' + apexJobID + '\' order by ApexClassId, MethodName', function (error, data) {
		if (error) {
			deferred.reject(new Error(error));
		} else {
			lo.each(data.records, function (row) {
				if (row.Outcome.toLowerCase() === 'fail') {
					// add details of failures to the test class map
					var apexClassName = test_class_map[row.ApexClassId].name;
					test_class_map[row.ApexClassId].failures.push({MethodName: row.MethodName, Message: row.Message, StackTrace: row.StackTrace});
					console.log(apexClassName + '.' + row.MethodName + ' : ' + row.Outcome + ' - ' + row.Message + '\n' + row.StackTrace);
				}
			});
			deferred.resolve();
		}
	});

	return deferred;
}

/**
* Gets the test data and builds an array of the number of times the line was tested
*/
var buildCoverage = function () {
	'use strict';

	var max_line, coverage_size, class_id, i,
		deferred = Q.defer();

	console.log('Fetching code coverage information');
	pageClient.emit('messages', 'Fetching code coverage information');
	coverage_stats['Total Org Coverage'] = {
		NumLinesCovered:0,
		NumLinesUncovered:0,
		TotalLines:0,
		Coverage:0
	};

	sfdc_client.tooling.sobject('ApexCodeCoverageAggregate').find({}).execute(function (error, data) {
		if (error) {
			deferred.reject(new Error(error));
		} else {
			console.log('Got information about ' + lo.size(data) + ' tests');

			lo.forEach(data, function (row) {
				class_id = row.ApexClassOrTriggerId;

				if (lo.has(id_to_class_map, class_id)) {
					var class_name = lo.toString(id_to_class_map[class_id].name);
					coverage_stats[class_name] = {
						NumLinesCovered:row.NumLinesCovered,
						NumLinesUncovered:row.NumLinesUncovered,
						TotalLines:(row.NumLinesCovered + row.NumLinesUncovered),
						Coverage:lo.round((((row.NumLinesCovered + row.NumLinesUncovered) - row.NumLinesUncovered)/(row.NumLinesCovered + row.NumLinesUncovered))*100, 2)
					};
					coverage_stats['Total Org Coverage'] = {
						NumLinesCovered:(coverage_stats['Total Org Coverage'].NumLinesCovered + row.NumLinesCovered),
						NumLinesUncovered:(coverage_stats['Total Org Coverage'].NumLinesUncovered + row.NumLinesUncovered),
						TotalLines:(coverage_stats['Total Org Coverage'].TotalLines + row.NumLinesCovered + row.NumLinesUncovered)
					};
					coverage_stats['Total Org Coverage'].Coverage = lo.round(((coverage_stats['Total Org Coverage'].TotalLines - coverage_stats['Total Org Coverage'].NumLinesUncovered)/coverage_stats['Total Org Coverage'].TotalLines)*100, 2)
					//console.log(coverage_stats['Total Org Coverage']);
					max_line = lo.max(lo.union(row.Coverage.coveredLines, row.Coverage.uncoveredLines));
					coverage_size = lo.size(id_to_class_map[class_id].coverage);

					if (max_line > coverage_size) {
						for (i = coverage_size; i <= max_line; i += 1) {
							id_to_class_map[class_id].coverage.push(null);
						}
					}

					lo.forEach(row.Coverage.coveredLines, function (line_number) {
						if (id_to_class_map[class_id].coverage[line_number - 1] === null) {
							id_to_class_map[class_id].coverage[line_number - 1] = 1;
						} else {
							id_to_class_map[class_id].coverage[line_number - 1] += 1;
						}
					});

					lo.forEach(row.Coverage.uncoveredLines, function (line_number) {
						if (id_to_class_map[class_id].coverage[line_number - 1] === null) {
							id_to_class_map[class_id].coverage[line_number - 1] = 0;
						}
					});
				}
			});
			//console.log(id_to_class_map);
			deferred.resolve();
		}
	});

	return deferred.promise;
};

/**
* Process data to CSV
*/
var saveToCSVRows = function () {
	'use strict';

	//console.log(coverage_stats);

	var writer = csvWriter(),
		deferred = Q.defer();
	writer.pipe(fs.createWriteStream(CSVFilename));
	//coverage_stats.sort();

	lo.forEach(coverage_stats, function (row, apexClassName) {

		writer.write({"Apex Class/Trigger Name":apexClassName,"Coverage Percentage":row['Coverage']});

		if (apexClassName == 'Total Org Coverage') {
			console.log('Total Org Coverage: ' + row['Coverage'] + ' (' + row['NumLinesCovered'] + '/' + row['TotalLines'] + ')');
		}
	});
	writer.end();
	deferred.resolve();
	return deferred.promise;
}

/**
* Process data to CSV
*/
var saveToCSVCols = function () {
	'use strict';

	console.log('Writing to file for Jenkins');

	var writer = csvWriter({headers: ["class name", "coverage"]}),
		deferred = Q.defer();
	writer.pipe(fs.createWriteStream(CSVFilename));
	//coverage_stats.sort();

  var temp = lo.mapValues(coverage_stats, 'Coverage');
  var keys = lo.keys(temp).sort().reverse();
  lo.forEach(keys,function(key) {
    writer.write([key, temp[key]]);
  });

	console.log('Total Org Coverage: ' + coverage_stats['Total Org Coverage'].Coverage + ' (' + coverage_stats['Total Org Coverage'].NumLinesCovered + '/' + coverage_stats['Total Org Coverage'].TotalLines + ')');
	writer.end();
	deferred.resolve();
	return deferred.promise;
}

var writeHTML = function () {
	'use strict';
  pageClient.emit('messages', 'Generating result page');

	var deferred = Q.defer();
	var graph_height = 1000 + (lo.size(coverage_stats) * 10);
	var html = '<head>\n  <!-- Plotly.js -->\n  <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>\n</head>\n\n<body>\n  \n  <div id="myDiv" style="width: 100%; height: '+graph_height+'px;"><!-- Plotly chart will be drawn inside this DIV --></div>\n  <script>\n    <!-- JAVASCRIPT CODE GOES HERE -->';
	var script_end = ';\nvar layout = {\n\ttitle: \'Test Coverage\',\n\thovermode:\'closest\',\n\tbarmode:\'overlay\',\n\tmargin: {\n\t\tl:250\n\t},\tshowlegend: true,\n\tlegend: {\n\t\tx: 0,\n\t\ty: 100\n\t}\n\t};\nPlotly.newPlot(\'myDiv\', data, layout);</script>'
	var html_end = '</body>';

    var temp = lo.mapValues(coverage_stats, 'Coverage');
    console.log(temp);
    var keys = lo.keys(temp).sort().reverse();
    // Remove the Total Org Coverage from the keys
    lo.pull(keys,'Total Org Coverage');
    // Add it back at the end so it displays at the top of the graph
    keys.push('Total Org Coverage');
    var keys_str = '';
    var values_str = '';
    var sfCover = '';
    var orgCover = '';
    try {
	    lo.forEach(keys,function(key) {
		    // console.log('key:' + keys_str.length + ', value:' + values_str.length);
		    // console.log('sfCover:' + sfCover.length + ', orgCover:' + orgCover.length);
	    	if (keys_str.length == 0) {
	    		keys_str = keys_str + '\'' + key + '\'';
	    	} else {
	    		keys_str = keys_str + ', ' + '\'' + key + '\'';
	    	}

	    	var value = temp[key];
	    	if (values_str.length == 0) {
	    		values_str = values_str + value;
	    		sfCover = sfCover + 75;
	    		orgCover = orgCover + 85;
	    	} else {
	    		values_str = values_str + ', ' + value;
	    		sfCover = sfCover + ', ' + 75;
	    		orgCover = orgCover + ', ' + 85;
	    	}
	    });
	} catch (error) {
	    console.log('key:' + keys_str + ', values_str:' + values_str + ', sfCover:' + sfCover + ', orgCover:' + orgCover);

		deferred.reject(new Error(error));
		return deferred.promise;
	}

    var data = '\nvar trace1={\n\
    	name:\'Code Coverage %\',\n\
    	//hoverinfo:"x+y",\n\
    	y:[' + keys_str + '],\n\
    	x:[' + values_str + '],\n\
    	type: \'bar\',\n\
    	orientation:\'h\',\n\
    	showlegend: false\n\
    };\n\
    var trace2={\n\
    	name:\'Salesforce Required Coverage Level\',\n\
    	//hoverinfo:\'Salesforce Required Coverage Level\',\n\
    	y:[' + keys_str + '],\n\
    	x:[' + sfCover + '],\n\
    	type: \'scatter\',\n\
		mode:\'lines\',\n\
		showlegend: true,\n\
		marker: {\n\
			color: \'red\',\n\
			width: 3\n\
		}\n\
    };\n\
    var trace3={\n\
		name:\'Org Required Coverage Level\',\n\
    	y:[' + keys_str + '],\n\
    	x:[' + orgCover + '],\n\
    	type: \'scatter\',\n\
		mode:\'lines\',\n\
		showlegend: true,\n\
		marker: {\n\
			color: \'green\',\n\
			width: 3\n\
		}\n\
    };\n\
    var data=[trace1,trace2,trace3]';

    var failedTests = '';
    lo.forEach(test_class_map, function(testClass, id) {
    	lo.forEach(testClass.failures, function(failure) {
	    	failedTests = failedTests + '\t<tr><td>' + testClass.name + '</td><td>' + failure.MethodName + '</td><td>' + failure.Message + '</td><td>' + failure.StackTrace+ '</td></tr>';
    	})
    });
    if (failedTests.length > 0) {
    	failedTests = '<br/><H1>ERROR - Tests have failed</H1><Table><TH>Test Class Name</TH><TH>Test Method Name</TH><TH>Message</TH><TH>Stack Trace</TH>' + failedTests + '</Table>';
    }

    var uncompiledClasses = '';
    if (lo.size(classes_to_be_recompiled) > 0) {
    	uncompiledClasses = '<br/><H1>WARNING these classes need to be recompiled in the org to allow proper Test Coverage to be calculated.</H1><br/><ul>\n';

    	lo.forEach(classes_to_be_recompiled,function(value, key) {
    		uncompiledClasses = uncompiledClasses + '\t<li>' + key + '</li>';
    	});
    	uncompiledClasses = uncompiledClasses + '</ul><br/>\n';
    }

    if (html_testClasses_seeAllData.length > 0) {
    	html_testClasses_seeAllData = '<br/><H1>WARNING these Test Classes are using See All Data annotation</H1><br/><ul>\n' +
    									html_testClasses_seeAllData + '</ul><br/>\n';
    }

    fs.writeFile(HTMLFilename, html + data + script_end + failedTests + html_testClasses_seeAllData + uncompiledClasses + html_end);
    errorOccurred = false;
    deferred.resolve();
    return deferred.promise;
}

/**
* Posts the data to coveralls
*/
// var postToCoveralls = function () {
// 	'use strict';

// 	var fs_stats, post_options,
// 		deferred = Q.defer(),
// 		coveralls_data = {
// 			repo_token: process.env.COVERALLS_REPO_TOKEN,
// 			service_name: 'travis-ci',
// 			service_job_id: process.env.TRAVIS_JOB_ID,
// 			source_files: lo.values(id_to_class_map)
// 		};

// 	console.log('Posting data to coveralls');

// 	fs.writeFile('/tmp/coveralls_data.json', JSON.stringify(coveralls_data), function (fs_error) {
// 		if (fs_error) {
// 			deferred.reject(new Error(fs_error));
// 		} else {
// 			fs_stats = fs.statSync('/tmp/coveralls_data.json');

// 			post_options = {
// 				multipart: true,
// 				data: {
// 					json_file: restler.file('/tmp/coveralls_data.json', null, fs_stats.size, null, 'application/json')
// 				}
// 			};

// 			restler.post('https://coveralls.io/api/v1/jobs', post_options).on("complete", function (data) {
// 				deferred.resolve();
// 			});
// 		}
// 	});

// 	return deferred.promise;
// };

function queueSteps() {
  Q.fcall(sfdcLogin)
  	.then(buildClassIdToClassDataMap)
  	.then(buildAddTriggersToClassIDMap)
 	.then(runAllTests)
	.then(waitUntilTestsComplete)
	.then(queryFailedTests)
  	.then(buildCoverage)
  	.then(saveToCSVCols)
  	.then(writeHTML)
  	.catch(function (error) {
  		'use strict';
  		console.log(error);
  	})
  	.done(function () {
  		'use strict';
  		sfdcLogout();
  	});
}
