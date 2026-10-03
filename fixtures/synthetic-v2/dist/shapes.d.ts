export interface Circle {
  radius: number;
}
export interface Square {
  side: number;
}
export declare function area(shape: Circle | Square): number;
