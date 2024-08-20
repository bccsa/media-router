# ENV File Editor 
***NB!!! This is a env editor for your own distrobution***

## Configure editor 
To change the path of the env file you need to pass the path as a process argument to the node process 
```bash
node router.js <Path to profile conf> <Path to your ENV file>
```

## Notes on the env editor 
* This editor only loads the env file on startup, and then saves the changes back to the file, if you make changes to the file from the cli, after the process has started, those chages will be overwritten
* This is a env editor for your own distrobution, none of these env arguments is used by the media-router process by default