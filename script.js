var canvas = document.getElementById("golCanvas");
	canvas.width = $(document).width();
	canvas.height = $(document).height();
	var WIDTH = canvas.width;
	var HEIGHT = canvas.height;
	var ctx = canvas.getContext("2d");
	var LEN = 14;
	var x = Math.floor(WIDTH/LEN) + 2;
	var y = HEIGHT/LEN + 2;
	var myGol;
	var golTmp;
			
	function initTmp(){
		for(var xVal = 0; xVal<x; xVal++){
	    golTmp[xVal] = new Array();
		    for(var yVal = 0; yVal<y; yVal++){
			    golTmp[xVal][yVal] = 0;
		    }
	    }	
	}	
	function initMatrix(){
		// reset matrix
		myGol = new Array();
		golTmp = new Array();
	
	    for(var xVal = 0; xVal<x; xVal++){
	    	myGol[xVal] = new Array();
	    	golTmp[xVal] = new Array();
		    for(var yVal = 0; yVal<y; yVal++){
			    golTmp[xVal][yVal] = 0;
			    var randVal = Math.floor((Math.random()*2));
			    myGol[xVal][yVal] = 0;
		    }
	    }
	}
	function draw(x,y){
		ctx.fillRect(LEN*(x-1),LEN*(y-1),LEN,LEN);
	}
	function setCell(xVal, yVal) {
		golTmp[xVal][yVal] = 1;
		ctx.fillStyle = "rgb(255,255,255)";
		draw(xVal,yVal);
	}
	function initiateCell(xVal, yVal) {
		setCell(xVal, yVal);
		myGol[xVal][yVal] = 1;
	}
	function nextStep(){
		// reset tempArray
		initTmp();
		// reset canvas
		ctx.fillStyle = "rgb(100,100,100)";
		ctx.fillRect(0,0,WIDTH,HEIGHT);

	    for(var xVal = 0; xVal<x; xVal++){
		    for(var yVal = 0; yVal<y; yVal++){
			    var neighbourSum = 0;

			    var xMinus = xVal - 1;
			    if (xMinus < 0) {
			    	xMinus = x - 2;
			    }
			    var yMinus = yVal - 1;
			    if (yMinus < 0) {
			    	yMinus = y - 2;
			    }

			    var xPlus = xVal + 1;
			    if (xPlus >= x) {
			    	xPlus = 1;
			    }
			    var yPlus = yVal + 1;
			    if (yPlus >= y) {
			    	yPlus = 1;
			    }

			    neighbourSum += myGol[xMinus][yVal];
			    neighbourSum += myGol[xMinus][yMinus];
			    neighbourSum += myGol[xMinus][yPlus];
			    neighbourSum += myGol[xVal][yMinus];
			    neighbourSum += myGol[xVal][yPlus];
			    neighbourSum += myGol[xPlus][yVal];
			    neighbourSum += myGol[xPlus][yMinus];
			    neighbourSum += myGol[xPlus][yPlus];
			    
			    if(myGol[xVal][yVal] == 1) {
				    if(neighbourSum == 2 || neighbourSum == 3){
				    	setCell(xVal, yVal);
				    }
				} else {
					if(neighbourSum == 3) {
						setCell(xVal, yVal)
					}
				}
		    }
	    }
	    myGol = golTmp.slice();   
	}
	function toggleCell(event) {
		 console.log("x coords: " + event.clientX + ", y coords: " + event.clientY);
		 var x_pos = event.clientX;
		 var y_pos = event.clientY;
		 var xVal = Math.floor((x_pos + LEN)/LEN);
		 var yVal = Math.floor((y_pos + LEN)/LEN);
		 console.log("xVal: " + xVal + ", yVal: " + yVal);
		 setCell(xVal, yVal);
	}

	function placeGlider(x_pos, y_pos) {
		initiateCell(x_pos, y_pos);
		initiateCell(x_pos, y_pos + 2);
		initiateCell(x_pos + 1, y_pos + 1);
		initiateCell(x_pos + 1, y_pos + 2);
		initiateCell(x_pos + 2, y_pos + 1);
	}
	function placeUpGlider(x_pos, y_pos) {
		initiateCell(x_pos, y_pos);
		initiateCell(x_pos, y_pos - 2);
		initiateCell(x_pos - 1, y_pos - 1);
		initiateCell(x_pos - 1, y_pos - 2);
		initiateCell(x_pos - 2, y_pos - 1);
	}

	function placeContent() {
		placeNav();
		placeSubtitle();
	}
	function placeNav() {
		var d = document.getElementById('nav');
		left = $(document).width() - 300;
		d.style.left = left+'px';
		d.style.top = 30+'px';
	}
	function placeSubtitle() {
		var d = document.getElementById('subtitle');
		left = Math.floor($(document).width()/2) - 200;
		top = $(document).height() - 200;
		d.style.left = left+'px';
		d.style.top = top+'px';
	}

	initMatrix();
	placeContent();
	placeGlider(Math.floor(x*0.8), Math.floor(y*0.2));
	placeGlider(Math.floor(x*0.8), Math.floor(y*0.8));
	// placeUpGlider(Math.floor(x*0.4), Math.floor(y*0.1));


	setInterval(nextStep, 3000);

	document.addEventListener("click", toggleCell);
	window.addEventListener('resize', placeContent, true);



