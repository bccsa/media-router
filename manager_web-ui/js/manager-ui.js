let Object2 = {
    id : 0, 
    cle2 : 'valeur2',
    cle3 : 'valeur3',
}

let Objects = []

function Add(Object1, Objects) {
    for(let i=0 ; i < 4 ; i++){
        Objects.push(Object1);
        console.log(Object1.id = i) 
    }

    Objects.forEach(el => {
        
    });


     console.log(Objects);
}

Add(Object2, Objects); 

const convertArrayToObject = (array, key) => {
  const initialValue = {};
  return array.reduce((obj, item) => {
    return {
      ...obj,
      [item[key]]: item,
    };
  }, initialValue);
}; 

console.log(convertArrayToObject(Objects, 'id'))

 