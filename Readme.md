# Get Salesforce Test Coverage

A node js project which helps getting the test coverage from your Salesforce org

## Screen shots ##
[[https://github.com/Lanceshi2/GetSFTestCoverage/blob/master/getCoverage.GIF]]
[[https://github.com/Lanceshi2/GetSFTestCoverage/blob/master/result.GIF]]

## Prerequisites ##
You need to ensure you have installed node js first. To download node js. Go to https://nodejs.org/en/

For Windows users, you need to install git for Windows to make npm install working. And make sure git.exe is in your path setting.

## Usage ##

Download the .zip and unzip it. In your command line, go to the folder and type npm install to install all the required packages.

Run node coverageEngine.js, then your local node server is running.

In your browser, open http://localhost:3000/home. Input your Salesforce url: login.salesforce.com for production or developer edition or test.salesforce.com for Sandbox.

Then type in your user name and password. Note that password is actually your password + security token. Then click Retrieve Test Coverage Button.

After the process is completed. You can view the results by clicking Open result page button.

## License ##
MIT
